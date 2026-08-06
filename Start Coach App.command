#!/bin/bash
# Coach Fulfillment System — double-click to start.
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js is not installed yet."
  echo "  Download it from  https://nodejs.org  (the LTS version),"
  echo "  run the installer, then double-click this file again."
  echo ""
  read -n 1 -s -r -p "  Press any key to close..."
  exit 1
fi

MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
if [ "$MAJOR" -lt 22 ]; then
  echo ""
  echo "  Your Node.js version ($(node -v)) is too old — version 22+ is required."
  echo "  Download the current LTS from  https://nodejs.org  and install it,"
  echo "  then double-click this file again."
  echo ""
  read -n 1 -s -r -p "  Press any key to close..."
  exit 1
fi

IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "")
clear
echo "============================================================"
echo "  COACH FULFILLMENT SYSTEM"
echo ""
echo "  You:        http://localhost:3002"
if [ -n "$IP" ]; then
echo "  Your team:  http://$IP:3002   (same Wi-Fi/network)"
fi
echo ""
echo "  First run only: your admin password appears below — save it."
echo "  Keep this window open. Closing it stops the app."
echo "============================================================"
echo ""
( sleep 2 && open "http://localhost:3002" ) &

PORT=3002 exec node server.js
