@echo off
title RimMind LM Studio Bridge Launcher
cd /d "%~dp0"

:: Clean quotes from PATH to prevent CMD parser issues with malformed PATH environment variables
set PATH=%PATH:"=%

echo ============================================
echo   RimMind Bridge Launcher
echo ============================================
echo.

:: Check Node.js installation
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed!
    echo Please install Node.js from https://nodejs.org/ to run the bridge.
    echo.
    pause
    exit /b 1
)

:: Auto-install dependencies if node_modules folder is missing
if not exist "node_modules" (
    echo [INFO] First-time startup: Installing dependencies [this may take a minute]...
    call npm install --no-audit --no-fund >nul
    echo [SUCCESS] Dependencies installed.
    echo.
)

:: Auto-generate SSL certificates if missing
if not exist "certificate.pfx" (
    echo [INFO] SSL certificate missing. Running certificate generator...
    echo You may see a Windows security prompt to trust the local certificate.
    echo Please click YES to allow secure HTTPS connections to localhost.
    echo.
    call npm run setup-certs
    echo.
)

:: Start the Node server and open default browser
echo [INFO] Starting the bridge server...
start "" "https://localhost:3000"
node server.js

pause
