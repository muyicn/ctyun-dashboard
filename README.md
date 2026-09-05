# ☁️ 天翼云电脑多账号自动化管理与保活控制台 (CtYun Web Dashboard)


本应用AI生成，README也是AI生成，提供网页支持而已。

本项目是对 **[leleji/CtYun](https://github.com/leleji/CtYun)** 与 **[bytehola/ctyun-auto](https://github.com/bytehola/ctyun-auto)** 进行全面功能深度分析、重构融合后打造的**现代化、UI 可视化、多账号**的 Docker 应用。


---

## 📊 一、功能深度对比分析表

| 功能模块 | CtYun (原版 C#) | ctyun-auto (自动化脚本) | 本项目 (CtYun Dashboard 可视化平台) |
| :--- | :--- | :--- | :--- |
| **交互形态** | 仅控制台命令行，无界面 | 仅 Docker 终端交互，无界面 | **现代化 Web 可视化控制台**，PC/手机自适应暗黑科技 UI |
| **多账号支持** | 手动编辑 `accounts.json` | 仅支持单账号环境变量单容器运行 | **UI 一键增删改查多账号**，支持为每个账号独立分配不同策略 |
| **设备码 (DeviceCode)** | 随机生成并保存至 `devices/{name}.txt` | 保存至 `.devicecode_{user}` | **UI 支持一键生成或自定义**，自动持久化，避免频繁风控 |
| **短信验证码绑定** | 必须在终端控制台实时交互输入 | 必须 `docker run -it` 终端前台输入 | **Web 弹窗一键发送短信并在线输入绑定**，告别命令行操作！ |
| **云电脑 WebSocket 保活** | 支持长连接，收到 REDQ 响应 OAEP 加密心跳 | 沿用 CtYun 镜像，每 24h 重启一次 | **完整保活守护引擎**，UI 实时显示在线/离线，支持异常自动重连与一键重启 |
| **每日签到打卡** | ❌ 无 | ❌ 无显式打卡模块 | **✅ 支持每日自动签到打卡**，UI 可自由开启/关闭，支持立即签到 |
| **AI 对话积分任务** | ❌ 无 | ✅ `login_script.py`，预置对话获取积分 | **✅ 多账号 AI 智能对话**，Cookie 免密登录，支持自定义话术与立即触发 |
| **云电脑挂机 1 小时** | ❌ 无 | ✅ `pc_login.py`，挂机获取 300 积分 | **✅ 多账号异步挂机监控**，UI 实时展示已挂机时长与完成进度条 |
| **抽奖与自动兑换** | ❌ 无 | 需运行交互命令手工选商品和日期 | **✅ 全 UI 可视化抽奖/兑换配置**：下拉框直观勾选奖品、设置每月几号/每日/间隔兑换 |
| **长期维持 8C16G** | ❌ 无 | ✅ 推荐每月最后一天兑换一次 | **✅ 内置最佳实践策略**（支持 `-1` 月末自动兑换），无缝维持整月高配 |
| **定时任务控制** | ❌ 无 | 依赖容器内 crontab，修改需进容器 | **✅ 可视化 Cron 调度中心**，直接在 UI 修改签到、对话、挂机、兑换时间 |
| **日志监控与排查** | 终端输出文字 | `docker logs` 查看纯文本 | **✅ Web 控制台 SSE 实时日志流**，彩色级别高亮，支持自动滚动/清屏 |
| **消息通知推送** | ❌ 无 | ❌ 无 | **✅ 集成多渠道推送**（Server酱、PushPlus、Bark、Telegram、Webhook） |

---

## 🚀 三、Docker 快速部署与运行

### 方式一：直接拉取预构建镜像（最推荐、飞牛 NAS 专用）

无需在 NAS 本地耗时编译，直接拉取 GitHub 自动构建好的预编译轻量镜像：

```bash
docker run -d \
  --name ctyun-dashboard \
  -p 8080:8080 \
  -v $(pwd)/data:/app/data \
  --restart unless-stopped \
  ghcr.io/muyicn/ctyun-dashboard:latest
```

或在 `docker-compose.yml` 中使用：
```yaml
version: '3.8'
services:
  ctyun-dashboard:
    image: ghcr.io/muyicn/ctyun-dashboard:latest
    container_name: ctyun-dashboard
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - ./data:/app/data
```

---

### 方式二：本地源码 Compose 快速构建（推荐开发者）

1. 进入项目根目录：
   ```bash
   cd ctyun-dashboard
   ```

2. 启动服务：
   ```bash
   docker compose up -d --build
   ```

3. 浏览器访问控制台：
   打开浏览器访问：**`http://你的服务器IP:8080`** 或 **`http://localhost:8080`**。
   - **默认初始超级管理员账号**：`admin`
   - **默认初始超级管理员密码**：`admin123`
   *(登录后可在右上角点击「🔒 修改密码」随时修改密码或管理员用户名)*

---

### 方式三：Docker 一键运行命令

```bash
docker run -d \
  --name ctyun-dashboard \
  -p 8080:8080 \
  -v $(pwd)/data:/app/data \
  --add-host "deskcdn.ctyun.cn:106.120.187.154" \
  --add-host "deskcdn.ctyun.cn.ctadns.cn:106.120.187.154" \
  --restart unless-stopped \
  ctyun-dashboard:latest
```

---

### 方式三：一键脚本部署

```bash
bash deploy.sh 8080
```

---

## 📖 四、Web 界面使用指引

### 1. 添加账号
1. 点击右上角 **`➕ 添加账号`**；
2. 输入天翼云绑定的手机号/账号与登录密码；
3. 设备码（DeviceCode）可留空，系统会自动生成并保存至 `data/devices/` 目录；
4. 点击保存，系统会自动生成与原版 CtYun 完全兼容的 `accounts.json`。

### 2. 短信验证码绑定设备
- 若账号在卡片上显示 `⚠️ 待短信绑定`，点击该按钮；
- 弹出短信验证窗口，点击 **`获取验证码`**；
- 收到手机短信后输入 6 位验证码，点击 **`确认绑定设备`**；
- 绑定完成后状态变为 `已绑设备`，后续无需再次绑定。

### 3. 配置自动兑换 / 抽奖（长期维持 8C16G）
- 在对应账号卡片中点击 **`⚙️ 奖品与抽奖设置`**；
- 打开“功能总开关”；
- 目标操作模式可选择“积分商城兑换”或“每日积分幸运抽奖”；
- 下拉框选择 **`升级 8C16G 配置 (300 积分)`**；
- 兑换策略选择“每月指定日期兑换”，填入 **`-1`**；
- 点击保存，系统即可在月末自动执行兑换升级。

### 4. 立即手动执行与定时调度
- 每个账号卡片底部均配有：
  - **`立即签到`**：一键手动签到打卡；
  - **`立即AI对话`**：一键发送对话领积分；
  - **`立即挂机`**：在后台启动无头浏览器执行 1 小时云电脑使用任务。
- 点击顶部 **`⚙️ 系统设置`**，可自定义各项任务的北京时间 Cron 表达式。

---

## 📁 五、持久化目录结构

挂载的 `./data` 目录包含：
```text
data/
├── app_config.json          # 主系统配置与账号策略信息
├── accounts.json            # 自动同步给 CtYun.dll 的原生多账号配置文件
├── devices/                 # 每个账号生成的设备标识码
│   └── 账号名.txt
├── ctyun_cookies_xxx_.json  # 各账号免密登录的 Cookie 缓存
└── ctyun_authData_xxx_.json # 云电脑端鉴权凭证
```
升级或重建容器时，只需保持 `./data` 目录挂载不变，所有配置与凭证均不丢失！
