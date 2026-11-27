# 🖥️ 云电脑可视化全功能多账号管理平台（天翼云 / 移动云三平台） w

深度逆向**天翼云电脑**与**中国移动云电脑**官方通信协议，打造的**现代化、高性能、超轻量、纯原生协议、零无头浏览器**的多账号云电脑自动化保活与任务管理控制台。

> ✨ **v2.3 移动公众全量融合 + SCG 底座打通 + 自动开机守护默认开启**：新增中国移动云电脑公众版（独立登录 + L1/L2 分层保活 + 开机/关机/重启 + 静默会话信号）与移动爱家「深信服 SCG」底座（官方 CEM 控制面，含开机能力恢复）；「🛡️ 自动开机守护」在移动公众与含 SCG 的移动爱家账号默认开启；30 天免登录；L3 占位层整层删除与日志降噪。
> ✨ **v2.2.1 稳定性与链路加固**：彻底解决天翼云每日打卡 40050 报错 (Issue #17) + 移动云 MQTT 官方报文适配与标准 8883 端口纠偏 + 双栈 IPv4 优先选路 + 前端多机周期精准联动 + 存储灾备双备份与钉钉加签支持。
> ✨ **v2.2 重大更新**：单账号多主机精细化独立纳管（Per-VM 独立保活/任务/开机守护）+ 高精度单机独立时间戳时间轮调度（Per-Device Timestamp Wheel）+ 状态层叠动态联动与当日轮次统计。
> ✨ **v2.1 全量融合**：全量融合中国移动云电脑（SOHO REST 签名加密 + ZTEC CAG TCP 三阶段握手），双云同台统一管理与统一配额。
> 📌 **依赖说明**：天翼云与移动爱家保活为零 Python 依赖的纯原生 Node.js 实现；移动公众协议侧车需 Python 3（Docker 镜像已内置 python3 + requests + pycryptodome，本机直跑需自备 Python 3.12），其签名常量已内置公开值、开箱即用（见部署指南 §3）。

---
![控制台总览](https://github.com/user-attachments/assets/1cea9bcb-b06c-4845-8940-74565a3aa88c)


## 🌟 核心功能与技术特性

### 1. ☁️ 天翼云 / 移动云 双平台全量融合
- **天翼云电脑（CtYun）**：WebSocket 长连接 + REDQ RSA-OAEP 挑战应答 + Type 118 身份信令 + Type 112 会话认领 + Type 7 心跳，全协议纯原生实现；
- **移动云电脑（YDPc）**：SOHO REST API（HMAC-SHA256 签名 + RSA 分段加密）+ ZTEC CAG TCP 三阶段握手保活 + 官方 MQTT 3.1.1 over TLS 长连接，**以原生 Node.js 完整实现，零 Python 依赖**；
- **主子账号体系**：移动云支持和家亲主账号与独立子账号，自动识别限时套餐（20 小时/月包）与永久时长，套餐耗尽智能熔断；
- **双云统一配额**：多用户配额体系下，天翼云与移动云账号统一计入配额管理。

### 2. 📱 手机 App 扫码一键登录 + 凭据安全托管
- **极速免密扫码**：直接通过手机「天翼云电脑 App」或「天翼账号」扫一扫授权登录，**免输图形验证码与短信**，扫码时可同时备注账号名；
- **密码加密落盘**：亦支持传统手机号密码登录，所有凭证均采用 **AES-256-GCM** 工业级加密持久化存盘；
- **多用户与权限隔离**：管理员 / 普通用户权限彻底解耦，全局系统与定时调度设置仅管理员可见；未登录访客完全阻断，普通用户仅能查看与操作自己名下的云电脑。

### 3. ⚡ 纯原生毫秒级通信，零无头浏览器，极低资源占用
- **彻底拔除 Chromium**：抛弃 Puppeteer / Playwright 等臃肿无头浏览器，全流程采用**毫秒级纯原生 HTTP + WebSocket / TCP 协议直连**；
- **内存常驻仅 20MB~35MB**：CPU 平时占用 0%，单核小机器、群晖 / 威联通 / 飞牛 / 绿联 NAS 及各类 VPS 均可长期稳定常驻运行。

### 4. 🛡️ 旁观者脉冲保活机制（彻底解决客户端互踢）
- **挂机模式（时长累加）**：任务未达标时发送完整会话认领包，真实累加官方 3600 秒（1 小时）使用时长，每日轻松拿满 300 积分；
- **旁观者脉冲模式（防休眠）**：时长达标或未开启挂机时自动切换为**旁观者连接（不发送独占认领包）**，仅做通道心跳重置官方休眠计时器，**官方手机 App / PC 客户端随时接入使用，绝不被踢掉线**；
- **单账号多机全量保活**：单账号名下多台云主机全部纳管保活（天翼云全形态：个人独立机 / 政企桌面池 / 抢占式；移动云全部云主机遍历守护）；
- **脉冲间隔自由配置**：10~3300 秒范围内自定义保活周期，卡片实时倒计时呈现。

### 5. 🖥️ 一键直达远程桌面与电源智能管理
- **Web 远程桌面免密直通**：点击「🚀 打开」在独立窗口直达云电脑桌面，1:1 自适应本机分辨率，鼠标键盘精准无偏移；
- **电源指令全覆盖**：天翼云 开机 / 唤醒 / 关机 / 重启直发官方协议（operationType 1/18/2/3）；移动云仅保留官方 SOHO 的**关机 / 重启**（开机能力已于 2026-09-22 移除）；
- **设备硬件规格展示**：双云统一显示设备 ID 与核心规格（几核几G），按官方套餐版本智能映射。

### 6. 🎯 官方任务自动化与智能兑换
- **每日签到打卡 / AI 智能对话 / 挂机 1 小时**：三大官方任务全自动执行，实时同步官方任务中心进度与总分；
- **多策略自动兑换**：支持每月指定日（含月末 -1）、每日、固定间隔天数三种策略，内置防重复兑换；完全对齐官方下单通道，含 3 秒随机防护与失败自动重试；
- **手动一键兑换**：商品列表直观展示名下绑定机器及当前积分余额，支持手动抢兑。

### 7. ⏰ 准点调度与分项 Cron 定时引擎
- **准点时间点触发**：支持每日准时执行时间点（如 `01:20` 或多时间点 `01:20, 12:00`），做完即休眠，绝不空转；
- **独立 Cron 规则**：可为签到、AI 对话、挂机时长、自动兑换单独设定 Cron 规则；
- **8 大渠道 Webhook 即时推送**：企业微信、钉钉、飞书（Markdown/卡片）、Bark、Server酱、PushPlus、Telegram、自定义 Webhook；**每用户独立推送渠道**，管理员与各普通用户通知互不串扰，内置 SSRF 防御自动拦截内网地址。

### 8. 🧩 现代化交互体验
- **网格自由排版**：账号卡片支持拖拽排序与行内留白放置（允许空位、不产生多余空行），布局状态按用户与平台视图持久化，刷新不走样；
- **无感刷新与滚动锁定**：全面重构为原地增量数据更新（In-Place Update），后台轮询不再整页重绘，彻底消除「刷着刷着跳回顶部」与操作被打断的问题；
- **平台视图切换与日志分流**：双云并存时自动呈现平台 Tab，实时控制台日志支持按平台（天翼/移动）与业务类型（任务/心跳）双维过滤；
- **品牌个性化**：管理员可自定义控制台主标题与副标题，全局即时生效。

---

## 🚀 极速部署指南

系统默认运行端口为：**`8571`**

### 方式一：Windows 一键快速启动（免 Docker）

本项目自带智能启动批处理脚本 `start_dashboard.bat`，适合在 Windows 本地电脑 / 虚拟机中直接运行：

1. **下载或克隆本项目**：
   ```bash
   git clone https://github.com/muyicn/ctyun-dashboard.git
   cd ctyun-dashboard
   ```
2. **直接双击运行 `start_dashboard.bat`**：
   - 脚本自动检测系统是否安装 Node.js（未安装会提示并引导至官网下载）；
   - 首次运行自动补齐依赖（`npm install`）；
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

#### 3. 📡 移动公众（公众版）：开箱即用，可选覆盖

移动公众的签名常量（AccessKey / SecretKey / RSA 密钥对）是**官方公众线客户端内置的固定材料**（公开信息），镜像与仓库已内置（`app/ecloud_engine/public_credentials.json`），**默认无需任何额外配置即可添加与保活移动公众账号**。加载优先级：

```
环境变量  >  覆盖文件  >  内置公开常量
```

只有在下面两种情况才需要"覆盖"：
- **平台轮换了这套 Key**，而你还不想升级镜像；
- 你想显式指定自己的一份（多环境隔离 / 审计留痕）。

覆盖方式（任选其一）：
- Docker / Compose：把文件放到 compose 同级的 `data/` 目录（容器内即 `/app/data/ecloud_credentials.json`，与 `./data:/app/data` 挂载天然对齐）；或显式挂载 `-v $(pwd)/credentials.json:/app/data/ecloud_credentials.json:ro`；
- 源码直跑：放到 `app/ecloud_engine/credentials.json`；
- 或用环境变量注入：`ECLOUD_ACCESS_KEY` / `ECLOUD_SECRET_KEY` / `ECLOUD_RSA_PUBLIC_PEM` / `ECLOUD_RSA_PRIVATE_PEM`。

字段形状见 `app/ecloud_engine/credentials.example.json`。这些常量**不含任何账号信息**——手机号、密码、会话 token 只存在本地 `data/` 目录，从不随仓库或镜像分发。

---

### 方式三：从源码直接构建运行

```bash
git clone https://github.com/muyicn/ctyun-dashboard.git
cd ctyun-dashboard

# 使用 Docker Compose 本地构建
docker compose up -d --build

# 或者使用 Node.js 直接运行 (Node.js >= 18)
npm install --omit=dev
node server.js
```

---

## 🔑 初始登录信息

- **访问地址**：`http://你的服务器IP:8571`
- **默认管理员账号**：`admin`
- **默认初始密码**：`admin123`
*(首次登录后，请立即在右上角头像菜单中修改密码)*

---

## 📁 项目结构

```
ctyun-dashboard/
├── server.js                 # 核心 HTTP/SSE 服务、双云驱动整合、API 路由
├── app/
│   ├── auth_manager.js       # 多用户会话、密码哈希、个人通知偏好
│   ├── ctyun_encryption.js   # 天翼云 REDQ RSA-OAEP 加解密核心
│   ├── ydpc/                 # 移动云电脑原生驱动 (零 Python 依赖)
│   │   ├── soho_client.js    #   SOHO REST 签名/加密/登录/心跳、官方关机/重启
│   │   ├── cag_client.js     #   ZTEC CAG TCP 三阶段握手
│   │   ├── mqtt_client.js    #   官方 MQTT 3.1.1 over TLS 长连接
│   │   └── ydpc_client.js    #   保活守护看门狗与生命周期管理
│   ├── tasks/                # 官方任务自动化 (签到/AI对话/挂机/兑换/调度)
│   └── static/               # 前端控制台 (原生 HTML/CSS/JS，无构建步骤)
├── data/                     # 运行时数据目录 (配置加密落盘，建议挂载持久化)
├── Dockerfile
└── docker-compose.yml
```

---


## 🔒 安全规范

1. **工业级加密**：所有云电脑账号密码及重要凭据均采用 AES-256-GCM 加密落盘；
2. **多租户权限隔离**：未登录访客完全阻断；普通用户仅能查看与操作自己名下的云电脑与日志；全局系统设置仅管理员可访问；
3. **SSRF 防御**：Webhook 推送严格校验目标地址，自动拦截本地回环与私有网段。

---

## 📜 免责声明

*本项目仅供自动化运维、技术研究与学习交流使用，请遵守天翼云、中国移动云电脑平台相关使用规范与协议。*

借鉴了ecloud-cmsszte-alive；leleji/CtYun等项目
