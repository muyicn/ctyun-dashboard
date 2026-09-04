#!/bin/bash
set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}======================================================${NC}"
echo -e "${GREEN}    ☁️ 天翼云电脑可视化多账号管理系统部署工具           ${NC}"
echo -e "${GREEN}======================================================${NC}\n"

if ! command -v docker &> /dev/null; then
    echo -e "${RED}[!] 错误: 未检测到 Docker，请先安装 Docker。${NC}"
    exit 1
fi

PORT=${1:-8080}
DATA_DIR="$(pwd)/data"
mkdir -p "$DATA_DIR/devices"

echo -e "${YELLOW}[*] 数据持久化目录: ${DATA_DIR}${NC}"
echo -e "${YELLOW}[*] Web 控制台端口: ${PORT}${NC}"

echo -e "\n${YELLOW}[1/3] 正在构建 Docker 镜像...${NC}"
docker build -t ctyun-dashboard:latest .

echo -e "\n${YELLOW}[2/3] 清理旧容器（如有）...${NC}"
if [ "$(docker ps -aq -f name=^ctyun-dashboard$)" ]; then
    docker rm -f ctyun-dashboard > /dev/null
fi

echo -e "\n${YELLOW}[3/3] 启动容器...${NC}"
docker run -d \
  --name ctyun-dashboard \
  -p "${PORT}:8080" \
  -v "${DATA_DIR}:/app/data" \
  --add-host "deskcdn.ctyun.cn:106.120.187.154" \
  --add-host "deskcdn.ctyun.cn.ctadns.cn:106.120.187.154" \
  --restart unless-stopped \
  ctyun-dashboard:latest

echo -e "\n${GREEN}======================================================${NC}"
echo -e "${GREEN}🎉 部署完成！${NC}"
echo -e "🌐 请在浏览器中打开 Web 管理控制台："
echo -e "   ${YELLOW}http://localhost:${PORT}${NC}  或  ${YELLOW}http://服务器IP:${PORT}${NC}"
echo -e ""
echo -e "📋 功能说明："
echo -e "   1. 打开网页即可添加和管理多个天翼云账号；"
echo -e "   2. 自由开启/关闭签到打卡、AI对话、挂机1小时、保活守护；"
echo -e "   3. 自动兑换配置可在 UI 直观选择升级 8C16G、抽奖等；"
echo -e "   4. 设备若需短信验证码，网页端支持一键发送短信并弹窗输入绑定；"
echo -e "   5. 实时查看保活心跳日志与任务进度。"
echo -e "${GREEN}======================================================${NC}"
