@echo off
chcp 65001 >nul
title 天翼云电脑多账号自动化管理平台
cd /d "%~dp0"

echo ==========================================================
echo    天翼云电脑可视化多账号自动化控制平台
echo ==========================================================
echo.

node -v >nul 2>&1
if errorlevel 1 goto NO_NODE

if not exist node_modules goto INSTALL_DEPS

:START_SERVER
echo [*] 正在启动 Web 控制台服务...
echo [*] 启动后请在浏览器中访问: http://127.0.0.1:8571
echo.
node server.js
echo.
echo [!] 服务已停止运行。
pause
exit /b

:NO_NODE
echo [!] 错误: 检测到当前系统尚未安装 Node.js 运行环境！
echo [*] 正在为您自动打开 Node.js 官方下载网站...
start https://nodejs.org/zh-cn
echo.
echo [*] 请下载安装完成后，重新双击运行本脚本即可。
pause
exit /b 1

:INSTALL_DEPS
echo [*] 检测到首次运行，正在自动安装必要依赖...
call npm install --omit=dev --registry=https://registry.npmmirror.com
if errorlevel 1 (
    echo [!] 依赖安装失败，请检查网络连接后重试。
    pause
    exit /b 1
)
echo [*] 依赖安装完成！
echo.
goto START_SERVER
