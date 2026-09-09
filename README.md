# ☁️ 天翼云电脑全功能多账号可视化管理平台 (CtYun Web Dashboard)

深度逆向天翼云官方通信协议与底层视讯流握手序列，打造出的**现代化、高性能、超轻量、纯原生协议、零无头浏览器、零重型 AI 依赖**的企业级多账号云电脑自动化管理控制台。

---

## 🌟 核心功能与技术特性

### 1. 📱 手机 App 扫码一键登录 + 凭据安全托管
- **极速免密扫码**：支持直接通过手机「天翼云电脑 App」或「天翼账号」扫一扫授权登录，**免输图形验证码与短信**，且扫码时可直接备注账号名；
- **密码加密落盘**：亦支持传统手机号密码登录，所有凭证与密码均采用 **AES-256-GCM** 工业级加密持久化存盘；
- **多账号与多租户权限隔离**：支持单账号下绑定多台云电脑，普通用户与管理员权限严格隔离，未登录访客完全阻断。

### 2. ⚡ 纯原生毫秒级通信，零无头浏览器，极低资源占用
- **彻底拔除 Chromium**：彻底抛弃 Puppeteer / Playwright 等臃肿的无头浏览器，全流程采用**毫秒级纯原生 HTTP + WebSocket 协议直连**；
- **内存常驻仅 20MB~35MB**：CPU 占用平时为 0%，无论是单核小机器、群晖 / 威联通 / 飞牛 / 绿联 NAS 还是各类 VPS，均可流畅长期稳定常驻运行。

### 3. 🛡️ 旁观者脉冲保活机制（彻底解决客户端互踢）
- **挂机模式（时长累加）**：任务未达标时，发送完整会话认领包，真实累加官方 3600 秒（1小时）使用时长，每日轻松拿满 300 积分；
- **旁观者脉冲模式（防休眠）**：时长达标或未开启挂机时，自动切换为**旁观者连接（不发送 112/104 独占认领包）**，仅做通道心跳重置官方 1 小时休眠计时器，**官方手机 App / PC 客户端随时接入使用，绝不被踢掉线**；
- **支持秒级脉冲间隔配置**：支持在 10~3300 秒范围内自定义保活脉冲周期，前端卡片实时倒计时呈现。

### 4. 🎁 智能商品与配置升级自动兑换
- **多策略智能判定**：支持**每月指定日（含月末 -1）、每日、固定间隔天数**三种兑换策略，内置 `lastRedeemDate` 严格防重复兑换；
- **真实参数防风控**：完全对齐官方下单通道（`pointType: 1` + 绑定机器数值 ID + 单笔单件串行提交 + 3秒随机防护），单笔失败支持自动重试 3 次；
- **手动一键兑换**：商品列表直观展示名下绑定机器及当前积分余额，支持手动一键抢兑。

### 5. ⏰ 准点调度与分项 Cron 定时引擎
- **准点时间点触发**：支持配置每日准时执行时间点（如 `01:20` 或多时间点 `01:20, 12:00`），做完即休眠，绝不盲目空转；
- **独立 Cron 规则**：高级模式可为每日签到、AI 智能对话、挂机时长任务、商品自动兑换单独设定 Cron 规则；
- **多渠道 Webhook 即时推送**：支持企业微信、Bark、Server酱、PushPlus、Telegram 实时推送每日执行汇总与异常告警。

### 6. 🖥️ 一键直达远程桌面与电源智能管理
- **Web 远程桌面免密直通**：点击「🚀 访问云电脑」在独立窗口直达云电脑桌面，1:1 自适应本机分辨率，鼠标键盘精准无偏移；
- **休眠自动唤醒与关机保护**：云电脑闲置休眠时后台自动下发官方电源指令唤醒；而在控制台主动关机时会自动打上保护标记，防止误开机。

---

## 🚀 极速部署指南

系统默认运行端口为：**`8571`**

### 方式一：Windows 一键快速启动（免 Docker）

本项目自带智能启动批处理脚本 `start_dashboard.bat`，非常适合在 Windows 本地电脑 / 虚拟机中直接运行：

1. **下载或克隆本项目**：
   ```bash
   git clone https://github.com/muyicn/ctyun-dashboard.git
   cd ctyun-dashboard
   ```
2. **直接双击运行 `start_dashboard.bat`**：
   - 脚本会自动检测系统是否安装了 Node.js（若未安装，会提示并一键引导至官网下载安装）；
   - 首次运行会自动使用国内高速源补齐依赖（`npm install`）；
   - 自动启动服务并输出控制台实时日志。
3. **访问系统**：打开浏览器访问 **`http://127.0.0.1:8571`**。

---

### 方式二：Docker / Docker Compose 部署（飞牛 / 绿联 / 群晖 NAS 推荐）

#### 1. 使用 Docker CLI 一键运行：
```bash
# Docker Hub 镜像 (推荐国内 NAS 用户拉取)
docker run -d \
  --name ctyun-dashboard \
  -p 8571:8571 \
  -v $(pwd)/data:/app/data \
  --restart unless-stopped \
  learycn/ctyun-dashboard:latest
```

或使用 GitHub Packages (GHCR) 镜像：
```bash
docker run -d \
  --name ctyun-dashboard \
  -p 8571:8571 \
  -v $(pwd)/data:/app/data \
  --restart unless-stopped \
  ghcr.io/muyicn/ctyun-dashboard:latest
```

#### 2. 使用 `docker-compose.yml` 部署：
在任意目录下创建 `docker-compose.yml`：
```yaml
version: '3.8'

services:
  ctyun-dashboard:
    image: learycn/ctyun-dashboard:latest # 或 ghcr.io/muyicn/ctyun-dashboard:latest
    container_name: ctyun-dashboard
    restart: unless-stopped
    ports:
      - "8571:8571"
    environment:
      - TZ=Asia/Shanghai
      - PORT=8571
      - CTYUN_DATA_DIR=/app/data
    volumes:
      - ./data:/app/data
```
运行启动命令：
```bash
docker compose up -d
```

---

### 方式三：从源码直接构建运行

```bash
git clone https://github.com/muyicn/ctyun-dashboard.git
cd ctyun-dashboard

# 使用 Docker Compose 本地构建
docker compose up -d --build

# 或者使用 Node.js 直接运行
npm install --omit=dev
node server.js
```

---

## 🔑 初始登录信息

- **访问地址**：`http://你的服务器IP:8571`
- **默认管理员账号**：`admin`
- **默认初始密码**：`admin123`
*(首次登录后，可在右上角管理员菜单中修改密码及用户名)*

---

## 🔒 安全规范

1. **工业级加密**：所有天翼云账号密码及重要凭据均采用 AES-256-GCM 加密落盘；
2. **多租户权限隔离**：未登录访客完全阻断，普通用户仅能查看与操作自己名下的云电脑与日志；
3. **SSRF 防御**：系统设置与 Webhook 推送严格校验目标地址，自动拦截本地回环与私有网段。

---

## 📜 免责声明

*本项目仅供自动化运维、技术研究与学习交流使用，请遵守天翼云平台相关使用规范与协议。*
