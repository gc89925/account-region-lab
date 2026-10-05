@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 from nodejs.org, then run this file again.
  pause
  exit /b 1
)
echo Open http://127.0.0.1:4317 in your browser.
node server.js
pause
