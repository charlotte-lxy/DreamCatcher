@echo off
cd /d "%~dp0"
if not exist logs mkdir logs
set ELECTRON_RUN_AS_NODE=
echo [%date% %time%] launch >> logs\launch.log
call npm start
echo [%date% %time%] exit=%errorlevel% >> logs\launch.log
echo.
echo 如果窗口没有出现，把上面的报错文字截图发给开发者。
pause
