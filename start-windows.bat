@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Download the LTS version from https://nodejs.org and run this file again. & pause & exit /b 1)
if not exist node_modules (echo Installing packages, first run only... & call npm install --omit=dev)
start "" http://localhost:3000
node server.js
pause
