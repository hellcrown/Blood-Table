@echo off
title 血色牌局 · 游戏服务器
cd /d "%~dp0"

echo ==========================================
echo   血色牌局 · 启动服务器
echo ==========================================
echo.

rem --- 1. 若端口 3000 已被旧实例占用，先询问是否停止 ---
set "OLD_PID="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000 " ^| findstr "LISTENING"') do set "OLD_PID=%%a"
if defined OLD_PID (
    echo [提示] 端口 3000 已被占用（PID %OLD_PID%），可能是正在运行的旧版服务器。
    echo        运行新代码前建议先停止它，否则本次启动会失败。
    choice /C YN /M "是否先停止旧服务器？[Y] 停止并启动  [N] 不停止直接启动"
    if errorlevel 2 goto :start
    taskkill /PID %OLD_PID% /F >nul 2>&1
    echo [完成] 已停止旧服务器进程。
    timeout /t 1 /nobreak >nul
)

:start
rem --- 2. 首次运行安装依赖 ---
if not exist node_modules (
    echo [提示] 首次运行，正在安装依赖...
    call npm install
    if errorlevel 1 (
        echo [错误] 依赖安装失败，请确认已安装 Node.js 20 或更高版本。
        pause
        exit /b 1
    )
)

rem --- 3. 缺少前端构建产物时先构建 ---
if not exist client\dist\index.html (
    echo [提示] 未检测到前端构建产物，正在构建...
    call npm run build
    if errorlevel 1 (
        echo [错误] 前端构建失败，请检查后重试。
        pause
        exit /b 1
    )
)

echo.
echo ==========================================
echo   正在启动服务器...（关闭本窗口或 Ctrl+C 停止）
echo ==========================================
echo.
call npm start
echo.
echo [提示] 服务器已退出（窗口被关闭或按了 Ctrl+C）。
pause