@echo off
setlocal
cd /d "%~dp0\..\.."

echo Keep Board Desktop dev mode (Tauri)
echo.
npm.cmd run tauri:dev

