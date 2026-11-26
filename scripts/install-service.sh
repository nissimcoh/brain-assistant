#!/bin/bash
# Installs Brain as a LaunchAgent: starts at login, restarts if it crashes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
LABEL="com.brain.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$HOME/.brain/logs"

if [[ -z "$NODE" ]]; then
  echo "לא נמצא node. התקן Node 24 ונסה שוב." >&2
  exit 1
fi
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if (( MAJOR < 24 )); then
  echo "נדרש Node 24 ומעלה (נמצא $("$NODE" -v))." >&2
  exit 1
fi

DOMAIN="gui/$(id -u)"

# Renamed from Felipe (0.15): stop and remove the service under the old name first, so nothing is
# writing to the database while its folder moves (~/.felipe → ~/.brain, by loadConfig below).
OLD_LABEL="com.felipe.server"
if launchctl print "$DOMAIN/$OLD_LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$OLD_LABEL" 2>/dev/null || true
  for _ in $(seq 1 20); do
    launchctl print "$DOMAIN/$OLD_LABEL" >/dev/null 2>&1 || break
    sleep 0.5
  done
  echo "✔ השירות בשם הישן (Felipe) הוסר."
fi
rm -f "$HOME/Library/LaunchAgents/$OLD_LABEL.plist"
(cd "$ROOT" && "$NODE" --disable-warning=ExperimentalWarning --input-type=module -e "
  const { loadConfig } = await import('./server/config.ts');
  loadConfig();
")
if [[ -d "$HOME/.felipe" ]]; then
  echo "✘ התיקייה ~/.felipe עדיין קיימת לצד ~/.brain. לא העברתי כלום כדי לא לדרוס נתונים. תגיד ל־Claude." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOGS"
chmod 700 "$HOME/.brain"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>$ROOT/server/main.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$LOGS/brain.log</string>
  <key>StandardErrorPath</key><string>$LOGS/brain.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

if ! plutil -lint "$PLIST" >/dev/null; then
  echo "קובץ ההגדרה של השירות לא תקין: $PLIST" >&2
  plutil -lint "$PLIST" >&2
  exit 1
fi

# Stop the running copy and wait until macOS has fully unloaded it.
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  for _ in $(seq 1 20); do
    launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
    sleep 0.5
  done
fi

# Load it again (retry: launchd sometimes needs a moment after an unload).
loaded=0
for attempt in 1 2 3 4 5; do
  if launchctl bootstrap "$DOMAIN" "$PLIST" 2>/tmp/brain-bootstrap.err; then
    loaded=1
    break
  fi
  sleep 1
done
if (( loaded == 0 )); then
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl kickstart -k "$DOMAIN/$LABEL"
  else
    echo "✘ הפעלת השירות נכשלה:" >&2
    cat /tmp/brain-bootstrap.err >&2
    exit 1
  fi
fi

for _ in $(seq 1 10); do
  curl -fsS http://127.0.0.1:8787/api/health >/dev/null 2>&1 && break
  sleep 1
done
if curl -fsS http://127.0.0.1:8787/api/health >/dev/null; then
  echo "✔ בריין רץ ברקע ויעלה אוטומטית בכל כניסה למק."
  echo "  יומן: npm run service:logs"
else
  echo "✘ השירות לא עונה. בדוק את היומן: tail -n 50 $LOGS/brain.log" >&2
  exit 1
fi
