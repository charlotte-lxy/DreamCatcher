@echo off
rem 部分 Windows 环境下 Chromium 沙箱初始化会崩溃（0x80000003），必须带 --no-sandbox 启动
cd /d "%~dp0"
start "" "%~dp0Dreamcatcher.exe" --no-sandbox
