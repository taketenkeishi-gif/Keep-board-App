@echo off
setlocal
cd /d "%~dp0"
echo [Info] build-release.bat is deprecated.
echo [Info] Use desktop-build-release.bat instead.
call "%~dp0desktop-build-release.bat"
