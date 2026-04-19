@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "APP_NAME=keep-board"
set "LOG_DIR=%~dp0logs"
set "LOG_FILE=%LOG_DIR%\run_desktop.log"
set "TAURI_CMD=%~dp0node_modules\.bin\tauri.cmd"
set "EXE=%~dp0src-tauri\target\release\keep-board.exe"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
> "%LOG_FILE%" echo ============================================================
>> "%LOG_FILE%" echo [%DATE% %TIME%] %APP_NAME% desktop build start
>> "%LOG_FILE%" echo ============================================================

call :log "============================================================"
call :log "[START] %APP_NAME% desktop build"
call :log "[ROOT ] %~dp0"
call :log "[LOG  ] %LOG_FILE%"
call :log "============================================================"

call :find_cargo
if not defined CARGO_EXE (
  call :log "[ERROR] cargo.exe was not found."
  call :log "[ERROR] Checked default Rust locations and current PATH."
  exit /b 1
)

if exist "%USERPROFILE%\.cargo" set "CARGO_HOME=%USERPROFILE%\.cargo"
if exist "%USERPROFILE%\.rustup" set "RUSTUP_HOME=%USERPROFILE%\.rustup"
set "PATH=%CARGO_BIN%;%PATH%"
set "RUST_BACKTRACE=1"

call :log "[CARGO] %CARGO_EXE%"
if defined CARGO_HOME call :log "[CARGO_HOME] %CARGO_HOME%"
if defined RUSTUP_HOME call :log "[RUSTUP_HOME] %RUSTUP_HOME%"

call :run_step "cargo version" "%CARGO_EXE%" --version
if errorlevel 1 exit /b %errorlevel%
call :run_step "rustc version" rustc --version
if errorlevel 1 exit /b %errorlevel%
call :run_step "cargo metadata probe" "%CARGO_EXE%" metadata --format-version 1 --no-deps --manifest-path "%~dp0src-tauri\Cargo.toml"
if errorlevel 1 exit /b %errorlevel%
call :run_step "npm install" npm.cmd install
if errorlevel 1 exit /b %errorlevel%

if not exist "%TAURI_CMD%" (
  call :log "[ERROR] Tauri CLI was not found: %TAURI_CMD%"
  exit /b 1
)

call :run_step "vite build" npm.cmd run build
if errorlevel 1 exit /b %errorlevel%
call :run_step "tauri build" "%TAURI_CMD%" build
if errorlevel 1 exit /b %errorlevel%

if not exist "%EXE%" (
  call :log "[ERROR] Build finished but executable was not found."
  call :log "[ERROR] Expected: %EXE%"
  exit /b 1
)

call :log "[SUCCESS] Build completed."
call :log "[EXE] %EXE%"
call :log "[LAUNCH] Starting desktop app..."
start "" "%EXE%"
exit /b 0

:find_cargo
set "CARGO_BIN="
set "CARGO_EXE="

for /f "delims=" %%I in ('where.exe cargo 2^>nul') do if not defined CARGO_EXE (
  set "CARGO_EXE=%%~fI"
  set "CARGO_BIN=%%~dpI"
)

for %%D in (
  "%USERPROFILE%\.cargo\bin"
  "%LOCALAPPDATA%\.cargo\bin"
  "%LOCALAPPDATA%\Programs\Rust\.cargo\bin"
  "%ProgramFiles%\Rust stable MSVC\bin"
  "%ProgramFiles%\Rust stable GNU\bin"
  "%ProgramFiles(x86)%\Rust stable MSVC\bin"
  "%ProgramFiles(x86)%\Rust stable GNU\bin"
) do if not defined CARGO_EXE if exist "%%~fD\cargo.exe" (
  set "CARGO_EXE=%%~fD\cargo.exe"
  set "CARGO_BIN=%%~fD\"
)

for %%S in ("%USERPROFILE%" "%LOCALAPPDATA%" "%ProgramFiles%" "%ProgramFiles(x86)%") do (
  if not defined CARGO_EXE if exist "%%~fS" (
    for /f "delims=" %%I in ('where.exe /r "%%~fS" cargo.exe 2^>nul') do if not defined CARGO_EXE (
      set "CARGO_EXE=%%~fI"
      set "CARGO_BIN=%%~dpI"
    )
  )
)
exit /b 0

:run_step
set "STEP_NAME=%~1"
shift
set "STEP_CMD=%1"
:run_step_build_cmd
shift
if "%~1"=="" goto run_step_build_done
set "STEP_CMD=%STEP_CMD% %1"
goto run_step_build_cmd
:run_step_build_done
set "RUNNER=%TEMP%\keep_board_runner_%RANDOM%%RANDOM%.cmd"
set "RCFILE=%TEMP%\keep_board_rc_%RANDOM%%RANDOM%.txt"

call :log "------------------------------------------------------------"
call :log "[STEP ] %STEP_NAME%"
call :log "[CMD  ] %STEP_CMD%"

> "%RUNNER%" (
  echo @echo off
  echo setlocal EnableExtensions
  echo call %STEP_CMD%
  echo ^> "%RCFILE%" echo %%errorlevel%%
)

for /f "usebackq delims=" %%L in (`"%RUNNER%" 2^>^&1`) do (
  echo(%%L
  >> "%LOG_FILE%" echo(%%L
)

set "STEP_RC=1"
if exist "%RCFILE%" set /p "STEP_RC=" < "%RCFILE%"
del "%RUNNER%" >nul 2>nul
del "%RCFILE%" >nul 2>nul

if not "%STEP_RC%"=="0" (
  call :log "[ERROR] %STEP_NAME% failed with exit code %STEP_RC%."
  exit /b %STEP_RC%
)

call :log "[OK   ] %STEP_NAME%"
exit /b 0

:log
echo %~1
>> "%LOG_FILE%" echo %~1
exit /b 0
