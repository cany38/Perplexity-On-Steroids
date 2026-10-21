@echo off
setlocal EnableExtensions

set "PID="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 8857 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"`) do set "PID=%%P"

if not defined PID (
  echo [info] Nothing is listening on 127.0.0.1:8857.
  pause
  exit /b 0
)

echo [stop] Killing PID %PID%...
taskkill /PID %PID% /F
if errorlevel 1 (
  echo [error] Could not kill PID %PID%.
  pause
  exit /b 1
)
del "%TEMP%\pos-panel.url" >nul 2>nul
echo [ok] Stopped.
pause
