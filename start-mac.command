#!/bin/bash
# Double-click to start EQ502P Remote on macOS.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS version from https://nodejs.org and run this again."
  read -n 1 -s -r -p "Press any key to close"; exit 1
fi
if [ ! -d node_modules/@julusian/midi ]; then
  echo "First run: installing the MIDI module..."
  npm install --omit=dev --no-audit --no-fund || { read -n 1 -s -r -p "Install failed. Press any key"; exit 1; }
fi
node server.js --open
