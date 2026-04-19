@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

set "LOGDIR=%CD%\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "STAMP=%%I"
set "LOGFILE=%LOGDIR%\run_desktop_%STAMP%.log"

call :log ----------------------------------------
call :log [Keep Board Desktop Runner]
call :log Root: %CD%
call :log Log : %LOGFILE%
call :log ----------------------------------------

where npm >> "%LOGFILE%" 2>&1
if errorlevel 1 (
  call :log [ERROR] npm was not found in PATH.
  echo.
  echo [FAILED] See log:
  echo %LOGFILE%
  echo.
  pause
  exit /b 1
)

call :log [RUN] npm install
call npm install >> "%LOGFILE%" 2>&1
if errorlevel 1 goto :fail

call :log [RUN] npm run tauri:build
call npm run tauri:build >> "%LOGFILE%" 2>&1
if errorlevel 1 goto :fail

if exist "src-tauri\target\release\keep-board.exe" (
  call :log [RUN] Launching built app
  start "" "src-tauri\target\release\keep-board.exe"
  call :log [DONE] App launched
) else (
  call :log [WARN] Build finished but keep-board.exe was not found.
)

echo.
echo [DONE] See log:
echo %LOGFILE%
echo.
pause
exit /b 0

:fail
call :log [ERROR] Command failed.
echo.
echo [FAILED] See log:
echo %LOGFILE%
echo.
pause
exit /b 1

:log
echo %*
>> "%LOGFILE%" echo %*
exit /b 0
