@echo off
cd /d "%~dp0"
echo Keep Board desktop dev
echo.
echo Rust is required for Tauri.
echo If this fails with "cargo not found", install Rust from https://rustup.rs/
echo.
npm.cmd run tauri:dev
