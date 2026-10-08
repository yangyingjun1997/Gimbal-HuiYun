@echo off
setlocal

cd /d "%~dp0"

rem 双击入口。所有参数原样转发给 start-win.ps1，
rem 由它完成依赖检查、询问吊舱 IP 与本地端口、网络自检，然后启动服务。
rem
rem 示例：
rem   start-win.bat
rem   start-win.bat -CheckOnly
rem   start-win.bat -GimbalIp 192.168.124.64 -Port 8090

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-win.ps1" %*

echo.
pause
