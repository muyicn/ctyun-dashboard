#!/bin/bash
set -e

DATA_DIR="/app/data"
mkdir -p "$DATA_DIR/devices"

echo "=========================================================="
echo "    ☁️ 天翼云电脑多账号自动化管理系统已启动"
echo "    🌐 Web 控制台访问端口: 8080"
echo "    📁 持久化数据目录: $DATA_DIR"
echo "=========================================================="

export RUNNING_IN_DOCKER="true"
export CTYUN_DATA_DIR="$DATA_DIR"

# 启动 Web 管理平台与任务引擎
exec python3 /app/main.py
