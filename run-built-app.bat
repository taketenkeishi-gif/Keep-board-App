@echo off
setlocal
cd /d "%~dp0"
echo [Info] run-built-app.bat is deprecated.
echo [Info] Use desktop-run-built.bat instead.
call "%~dp0desktop-run-built.bat"
