@echo off
rem Dev/Test helper. End-user download entry is GitHub Releases Setup.exe.
setlocal
cd /d "%~dp0"

set "EXE=%~dp0src-tauri\target\release\keep-board.exe"
if exist "%EXE%" (
  start "" "%EXE%"
  exit /b 0
)

set "INSTALLER="
for /f "delims=" %%F in ('dir /b /a:-d /o:-d "%~dp0src-tauri\target\release\bundle\nsis\*.exe" 2^>nul') do (
  set "INSTALLER=%~dp0src-tauri\target\release\bundle\nsis\%%F"
  goto :found_installer
)

:found_installer
if defined INSTALLER (
  echo Built app was not found. Launching latest installer:
  echo "%INSTALLER%"
  start "" "%INSTALLER%"
  exit /b 0
)

echo keep-board.exe was not found:
echo "%EXE%"
echo.
echo Attempting to build desktop app now...
where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo npm.cmd is not installed. Install Node.js, then run:
  echo   npm.cmd install
  echo   npm.cmd run tauri:build
  exit /b 1
)

call npm.cmd install
if errorlevel 1 (
  echo npm install failed.
  exit /b 1
)

call npm.cmd run tauri:build
if errorlevel 1 (
  echo tauri build failed.
  exit /b 1
)

if exist "%EXE%" (
  start "" "%EXE%"
  exit /b 0
)

echo Build completed but keep-board.exe is still missing.
echo Try downloading installer from GitHub Releases.
exit /b 1
