@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   imethai Auto Booker
echo ============================================
echo.

REM Check Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install from https://nodejs.org and try again.
  pause
  exit /b 1
)

REM Install deps if node_modules missing
if not exist "node_modules" (
  echo Installing dependencies for the first time...
  call npm install
  if errorlevel 1 ( echo npm install failed. & pause & exit /b 1 )
  call npm run install:browsers
  if errorlevel 1 ( echo Browser install failed. & pause & exit /b 1 )
)

REM Check config
if not exist "config.json" (
  echo [ERROR] config.json not found. Copy config.example.json to config.json and fill it in.
  pause
  exit /b 1
)

REM Run with visible browser
set HEADED=1
node auto-book.js

echo.
echo Bot finished. Press any key to close.
pause >nul
