@echo off
setlocal EnableExtensions
cd /d "%~dp0..\app"

where node >nul 2>nul
if errorlevel 1 (
  echo [error] Node.js not found. Install Node 18 or newer from https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [setup] Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [error] npm install failed.
    pause
    exit /b 1
  )
)

set "PID="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 8857 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"`) do set "PID=%%P"

if defined PID (
  echo [ok] Server is already running on 127.0.0.1:8857 ^(PID %PID%^).
  echo      endpoint: http://127.0.0.1:8857/mcp
  echo      panel:    open it to approve calls and get a permanent connector URL
  echo      log:      %%TEMP%%\pos-mcp.log
  echo.
  if exist "%TEMP%\pos-panel.url" (
    for /f "usebackq delims=" %%U in ("%TEMP%\pos-panel.url") do start "" "%%U"
    echo      Opened the local panel in your browser.
  ) else (
    echo      Panel: http://127.0.0.1:8859/ ^(restart the server if it needs a key^)
  )
  echo.
  echo      Run stop.bat to shut it down.
  pause
  exit /b 0
)

echo [start] Launching MCP server...
node scripts/start.mjs
if errorlevel 1 (
  echo [error] Failed to start. See %%TEMP%%\pos-mcp.log
  pause
  exit /b 1
)

echo.
echo [ok] Server started in the background.
echo      endpoint: http://127.0.0.1:8857/mcp
echo      panel:    open it to approve calls and get a permanent connector URL
echo      log:      %%TEMP%%\pos-mcp.log
echo      stop:     stop.bat
echo.
pause

