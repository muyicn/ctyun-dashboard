@echo off
chcp 65001 >nul
title 天翼云电脑多账号自动化管理平台

echo ==========================================================
echo    ☁️ 天翼云电脑可视化多账号自动化控制平台
echo ==========================================================
echo.

:: 1. 检查是否安装 Node.js 环境
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [!] 错误: 检测到当前系统尚未安装 Node.js 环境！
    echo [*] 本程序后端服务需要 Node.js (推荐 v18 或 v20 及以上版本)。
    echo.
    set /p choice="是否立即打开浏览器前往 Node.js 官方网站下载安装？(Y/N, 默认Y): "
    if /i "%choice%"=="" set choice=Y
    if /i "%choice%"=="Y" (
        echo [*] 正在打开 Node.js 官方下载页面 (https://nodejs.org/zh-cn)...
        start https://nodejs.org/zh-cn
        echo.
        echo [*] 请下载 LTS 长期支持版并完成安装，安装完成后重新双击本脚本即可！
    ) else (
        echo [*] 请自行访问 https://nodejs.org 下载并安装 Node.js。
    )
    echo.
    pause
    exit /b
)

:: 2. 检查依赖是否完备 (判断 node_modules 或 ws 是否存在)
if not exist "node_modules" (
    echo [*] 检测到首次运行，正在自动安装必要依赖 (npm install)...
    npm install --omit=dev --registry=https://registry.npmmirror.com
    if %errorlevel% neq 0 (
        echo [!] 依赖安装失败，请检查网络连接后重试。
        pause
        exit /b
    )
    echo [*] 依赖安装完成！
    echo.
)

:: 3. 启动核心服务
echo [*] Node.js 环境就绪，正在启动 Web 控制台服务...
echo [*] 启动后请在浏览器中打开: http://127.0.0.1:8571
echo.

node server.js
pause
