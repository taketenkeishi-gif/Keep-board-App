@echo off
setlocal
cd /d "%~dp0"
echo [Info] start.bat is deprecated.
echo [Info] Use web-dev.bat instead.
call "%~dp0web-dev.bat"
