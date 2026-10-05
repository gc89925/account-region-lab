@echo off
cd /d "%~dp0"
node scripts/launch.js --stop
if errorlevel 1 pause
