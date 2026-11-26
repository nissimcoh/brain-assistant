#!/bin/bash
# Stops Brain and removes the LaunchAgent. Data in ~/.brain is kept.
set -euo pipefail
LABEL="com.brain.server"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "✔ השירות הוסר. הנתונים נשארו ב־~/.brain"
