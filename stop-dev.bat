@echo off
setlocal

echo Stopping Moralis Charting dev ports...
powershell -ExecutionPolicy Bypass -File "%~dp0stop-dev.ps1"

echo Done.
