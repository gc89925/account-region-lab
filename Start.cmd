@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 from nodejs.org, then run this file again.
  pause
  exit /b 1
)
echo Open http://127.0.0.1:4317 in your browser.
if not exist "node_modules\playwright-core\package.json" (
  echo Run npm ci --ignore-scripts in this folder first.
  pause
  exit /b 1
)
node server.js
pause
