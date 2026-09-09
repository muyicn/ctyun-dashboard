@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
chcp 65001 >nul
title 天翼云电脑多账号自动化管理平台

echo ==========================================================
echo    ☁️ 天翼云电脑可视化多账号自动化控制平台
echo ==========================================================
echo.

rem 1. 检查 Node.js 运行环境
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] 错误: 检测到当前系统尚未安装 Node.js 运行环境！
    echo [*] 本程序后端服务需要 Node.js (推荐 v18 或 v20 及以上版本)。
    echo.
    echo [*] 正在为您自动打开 Node.js 官方下载页面 (https://nodejs.org/zh-cn)...
    start https://nodejs.org/zh-cn
    echo.
    echo [*] 请下载安装完成后，重新双击本脚本即可！
    echo.
    pause
    exit /b 1
)

rem 2. 检查依赖是否完备
if not exist "node_modules" (
    echo [*] 检测到首次运行，正在自动安装必要依赖 (npm install)...
    call npm install --omit=dev --registry=https://registry.npmmirror.com
    if !errorlevel! neq 0 (
        echo [!] 依赖安装失败，请检查网络连接后重试。
        pause
        exit /b 1
    )
    echo [*] 依赖安装完成！
    echo.
)

rem 3. 启动核心服务
echo [*] Node.js 环境就绪，正在启动 Web 控制台服务...
echo [*] 启动后请在浏览器中打开: http://127.0.0.1:8571
echo.

node server.js
if %errorlevel% neq 0 (
    echo.
    echo [!] 服务异常退出，请查看上方错误提示。
)
pause
