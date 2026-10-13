@echo off
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing Cursor Studio dependencies...
  call npm.cmd ci
  if errorlevel 1 (
    pause
    exit /b 1
  )
  call npm.cmd exec -- install-electron --no
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
set ELECTRON_RUN_AS_NODE=
start "Cursor Studio" "node_modules\electron\dist\electron.exe" .
