@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 from nodejs.org, then run this file again.
  pause
  exit /b 1
)
if not exist "node_modules\playwright-core\package.json" (
  echo Installing dependencies from package-lock.json...
  call npm ci --ignore-scripts --no-fund --no-audit
  if errorlevel 1 (
    echo Dependency installation failed. Please check your network and try again.
    pause
    exit /b 1
  )
)
node scripts/launch.js
if errorlevel 1 pause
