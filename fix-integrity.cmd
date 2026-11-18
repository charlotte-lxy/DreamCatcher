@echo off
setlocal
rem Dreamcatcher: reset the app folder's mandatory integrity label to Medium.
rem The workspace may have been created by a sandbox at Low integrity; Windows then
rem runs Dreamcatcher at Low too, and Low processes cannot start explorer.exe.
rem Run this file by double-clicking it (UAC will ask for elevation).

set "ROOT=%~dp0"
set "TARGET=%ROOT%dist\win-unpacked"
if not exist "%TARGET%\DreamcatcherApp.exe" if exist "%ROOT%DreamcatcherApp.exe" set "TARGET=%ROOT%"

if not exist "%TARGET%\DreamcatcherApp.exe" (
  echo Cannot find "%TARGET%\DreamcatcherApp.exe".
  echo Adjust TARGET in this script to the folder containing DreamcatcherApp.exe.
  pause
  exit /b 1
)

tasklist /FI "IMAGENAME eq DreamcatcherApp.exe" 2>nul | find /I "DreamcatcherApp.exe" >nul
if not errorlevel 1 (
  echo Dreamcatcher is still running. Close it first, then run this script again.
  pause
  exit /b 1
)

net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo Resetting integrity level to Medium:
echo   %TARGET%
icacls "%TARGET%" /setintegritylevel Medium /T /C /Q
icacls "%TARGET%\Dreamcatcher.exe" /setintegritylevel Medium /Q
icacls "%TARGET%\DreamcatcherApp.exe" /setintegritylevel Medium /Q
echo.
echo Done. Start Dreamcatcher.exe again and click the location button.
pause
