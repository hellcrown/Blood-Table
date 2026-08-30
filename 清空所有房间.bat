@echo off
title 血色牌局 · 一键清空所有房间
echo 正在检查服务器状态...
curl -s http://localhost:3000/api/health | findstr /C:"ok" >nul
if errorlevel 1 (
    echo [错误] 服务器未在运行（端口 3000 无响应），请先运行「启动服务器」。
    echo.
    pause
    exit /b 1
)
echo 服务器在线，正在清空所有房间...
echo.
for /f "delims=" %%r in ('curl -s -X POST http://localhost:3000/api/rooms/clear') do echo 返回：%%r
echo.
echo [完成] 所有房间已删除（在线玩家会被请回大厅）。
echo.
pause