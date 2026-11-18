@echo off
cd /d "%~dp0"
if not exist logs mkdir logs
set ELECTRON_RUN_AS_NODE=
echo ==== %date% %time% ==== >> logs\launch.log
node -v >> logs\launch.log 2>&1
call npm -v >> logs\launch.log 2>&1
echo ELECTRON_RUN_AS_NODE=[%ELECTRON_RUN_AS_NODE%] >> logs\launch.log
echo ---- electron start ---- >> logs\launch.log
call node_modules\.bin\electron.cmd . --enable-logging >> logs\launch.log 2>&1
echo exit=%errorlevel% >> logs\launch.log
echo.
echo ==== 诊断日志 ====
type logs\launch.log
echo.
pause
