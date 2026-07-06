@echo off
title RimSynapse Bridge Launcher (Python)
cd /d "%~dp0"

:: Clean quotes from PATH to prevent CMD parser issues
set PATH=%PATH:"=%

echo ============================================
echo   RimSynapse Bridge Launcher
echo ============================================
echo.

:: ── Step 1: Find or download Python ─────────────────────────────────
:: Check for embedded Python first, then system Python
set PYTHON_CMD=

if exist "python_embedded\python.exe" (
    set PYTHON_CMD=python_embedded\python.exe
    echo [OK] Using embedded Python.
    goto :HAVE_PYTHON
)

where python >nul 2>nul
if %errorlevel% equ 0 (
    set PYTHON_CMD=python
    echo [OK] Using system Python.
    goto :HAVE_PYTHON
)

:: Neither found — download embeddable Python
echo [INFO] Python not found. Downloading portable Python 3.12...
echo        This is a one-time download (~15 MB).
echo.

:: Download using PowerShell
powershell -ExecutionPolicy Bypass -Command ^
    "$url = 'https://www.python.org/ftp/python/3.12.8/python-3.12.8-embed-amd64.zip'; " ^
    "$zip = 'python_embedded.zip'; " ^
    "Write-Host '[INFO] Downloading...' ; " ^
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; " ^
    "Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing; " ^
    "Write-Host '[INFO] Extracting...' ; " ^
    "Expand-Archive -Path $zip -DestinationPath 'python_embedded' -Force; " ^
    "Remove-Item $zip -Force; " ^
    "Write-Host '[SUCCESS] Portable Python installed.' "

if not exist "python_embedded\python.exe" (
    echo [ERROR] Failed to download Python. Please check your internet connection.
    echo         Alternatively, install Python from https://www.python.org/ manually.
    pause
    exit /b 1
)

:: Enable pip in embedded Python by uncommenting import site
powershell -ExecutionPolicy Bypass -Command ^
    "$pthFiles = Get-ChildItem 'python_embedded' -Filter 'python*._pth'; " ^
    "foreach ($f in $pthFiles) { " ^
    "  $content = Get-Content $f.FullName; " ^
    "  $content = $content -replace '#import site', 'import site'; " ^
    "  Set-Content $f.FullName $content; " ^
    "}"

:: Install pip
echo [INFO] Installing pip into embedded Python...
powershell -ExecutionPolicy Bypass -Command ^
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; " ^
    "Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile 'get-pip.py' -UseBasicParsing"
python_embedded\python.exe get-pip.py --no-warn-script-location >nul 2>nul
del get-pip.py 2>nul

set PYTHON_CMD=python_embedded\python.exe
echo [SUCCESS] Embedded Python ready.
echo.

:HAVE_PYTHON

:: ── Step 2: Install dependencies if needed ──────────────────────────
if not exist "lib\flask" (
    echo [INFO] First-time startup: Installing dependencies...
    %PYTHON_CMD% -m pip install --target=lib --upgrade -r requirements.txt --no-warn-script-location >nul 2>nul
    if %errorlevel% neq 0 (
        echo [WARN] pip install with --target failed, trying without...
        %PYTHON_CMD% -m pip install -r requirements.txt --no-warn-script-location >nul 2>nul
    )
    echo [SUCCESS] Dependencies installed.
    echo.
)

:: Add lib to PYTHONPATH so embedded Python finds packages
set PYTHONPATH=%~dp0lib;%PYTHONPATH%

:: ── Step 3: Auto-generate SSL certificates if missing ───────────────
if not exist "certificate.pfx" (
    echo [INFO] SSL certificate missing. Running certificate generator...
    echo You may see a Windows security prompt to trust the local certificate.
    echo Please click YES to allow secure HTTPS connections to localhost.
    echo.
    powershell -ExecutionPolicy Bypass -File setup-certs.ps1
    echo.
)

:: ── Step 4: Start the Python server and open browser ────────────────
echo [INFO] Starting the bridge server...

:: Read port from config.json if it exists (default 3001)
set PORT=3001
for /f "tokens=2 delims=:, " %%a in ('findstr /C:"\"port\"" config.json 2^>nul') do set PORT=%%a

:: Determine protocol based on certificate presence
set PROTO=http
if exist "certificate.pfx" set PROTO=https

start "" "%PROTO%://localhost:%PORT%"
%PYTHON_CMD% server.py

pause
