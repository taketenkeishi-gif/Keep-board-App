@echo off
cd /d "%~dp0"
echo Keep Board dev server
echo.
echo Open this URL in your browser:
echo http://127.0.0.1:5173
echo.
npm.cmd run dev -- --port 5173
