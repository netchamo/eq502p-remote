@echo off
rem Double-click to start EQ502P Remote on Windows.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this again. & pause & exit /b 1)
if not exist node_modules\@julusian\midi (
  echo First run: installing the MIDI module...
  call npm install --omit=dev --no-audit --no-fund || (echo Install failed. & pause & exit /b 1)
)
node server.js --open
pause
