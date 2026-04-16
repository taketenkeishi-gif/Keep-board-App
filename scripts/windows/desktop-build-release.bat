@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0\..\.."

for /f "usebackq delims=" %%V in (`powershell -NoProfile -Command "(Get-Content package.json | ConvertFrom-Json).version"`) do set "APP_VERSION=%%V"
if "%APP_VERSION%"=="" (
  echo Failed to read version from package.json
  exit /b 1
)

set "APP_NAME=Keep-Board"
set "RELEASE_DIR=%cd%\release\%APP_NAME%-v%APP_VERSION%"
set "TAURI_RELEASE=%cd%\src-tauri\target\release"
set "NSIS_DIR=%TAURI_RELEASE%\bundle\nsis"
set "MSI_DIR=%TAURI_RELEASE%\bundle\msi"
set "PORTABLE_EXE=%TAURI_RELEASE%\keep-board.exe"

echo Building %APP_NAME% v%APP_VERSION%...
call npm.cmd run tauri:build
if errorlevel 1 (
  echo tauri build failed.
  exit /b 1
)

if exist "%RELEASE_DIR%" rmdir /s /q "%RELEASE_DIR%"
mkdir "%RELEASE_DIR%"

if exist "%PORTABLE_EXE%" (
  copy /y "%PORTABLE_EXE%" "%RELEASE_DIR%\%APP_NAME%-v%APP_VERSION%-Portable.exe" >nul
) else (
  echo Portable exe was not found: %PORTABLE_EXE%
)

for /f "delims=" %%F in ('dir /b /a:-d /o:-d "%NSIS_DIR%\*.exe" 2^>nul') do (
  copy /y "%NSIS_DIR%\%%F" "%RELEASE_DIR%\%APP_NAME%-v%APP_VERSION%-Setup.exe" >nul
  goto :nsis_done
)
:nsis_done

for /f "delims=" %%F in ('dir /b /a:-d /o:-d "%MSI_DIR%\*.msi" 2^>nul') do (
  copy /y "%MSI_DIR%\%%F" "%RELEASE_DIR%\%APP_NAME%-v%APP_VERSION%-Installer.msi" >nul
  goto :msi_done
)
:msi_done

(
  echo %APP_NAME% v%APP_VERSION%
  echo.
  echo Files:
  echo - %APP_NAME%-v%APP_VERSION%-Setup.exe ^(recommended^)
  echo - %APP_NAME%-v%APP_VERSION%-Installer.msi
  echo - %APP_NAME%-v%APP_VERSION%-Portable.exe
  echo.
  echo Generated: %DATE% %TIME%
) > "%RELEASE_DIR%\README.txt"

echo.
echo Release package created:
echo %RELEASE_DIR%
dir /b "%RELEASE_DIR%"
exit /b 0

