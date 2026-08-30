@echo off
title 血色牌局 · 停止服务器
echo 正在查找端口 3000 上的服务器进程...
set "FOUND="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000 " ^| findstr "LISTENING"') do (
    echo 停止进程 PID %%a
    taskkill /PID %%a /F >nul 2>&1
    set "FOUND=1"
)
echo.
if defined FOUND (
    echo [完成] 服务器已停止。
) else (
    echo 未检测到运行中的服务器（端口 3000 空闲）。
)
echo.
pause