@echo off
title NexusOS ISO builder
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0kit\build-iso.ps1"
echo.
pause
