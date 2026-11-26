#!/bin/bash
# Exposes Brain to your own devices only, over Tailscale with HTTPS. Nothing is opened to the internet.
set -euo pipefail

TS="$(command -v tailscale || true)"
if [[ -z "$TS" && -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]]; then
  TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
fi
if [[ -z "$TS" ]]; then
  echo "Tailscale לא מותקן. התקן מ־https://tailscale.com/download והתחבר." >&2
  exit 1
fi

if ! curl -fsS http://127.0.0.1:8787/api/health >/dev/null; then
  echo "בריין לא רץ. הפעל קודם: npm run service:install" >&2
  exit 1
fi

"$TS" serve --bg 8787
echo ""
"$TS" serve status
echo ""
echo "✔ פתח באייפון (כשהוא מחובר ל־Tailscale) את כתובת ה־https שמופיעה למעלה,"
echo "  ובספארי: שיתוף ← הוסף למסך הבית."
