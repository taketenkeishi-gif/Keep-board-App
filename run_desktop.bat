@echo off
setlocal
cd /d "%~dp0"

echo [Keep Board] update dependencies...
call npm.cmd install
if errorlevel 1 (
  echo npm install failed.
  exit /b 1
)

echo [Keep Board] rebuild desktop app...
call npm.cmd run tauri:build
if errorlevel 1 (
  echo tauri build failed.
  exit /b 1
)

set "EXE=%~dp0src-tauri\target\release\keep-board.exe"
if exist "%EXE%" (
  echo [Keep Board] launch desktop app...
  start "" "%EXE%"
  exit /b 0
)

echo Build finished but keep-board.exe was not found:
echo "%EXE%"
exit /b 1

