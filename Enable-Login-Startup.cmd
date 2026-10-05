@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -File "%~dp0scripts\windows-startup.ps1"
pause
