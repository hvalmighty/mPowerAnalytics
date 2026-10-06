#!/bin/bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js is not installed. Download the LTS version from https://nodejs.org and run this again."; read; exit 1; }
[ -d node_modules ] || npm install --omit=dev
(sleep 2; open http://localhost:3000) &
node server.js
