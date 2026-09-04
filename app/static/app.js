// 全局状态
let accounts = [];
let availableRewards = [];
let autoScroll = true;
let eventSource = null;
let currentUser = null;
let currentAuthToken = localStorage.getItem("ctyun_auth_token") || "";

// 请求包装：自动携带 token
async function authFetch(url, options = {}) {
  options.headers = options.headers || {};
  if (currentAuthToken) {
    options.headers["Authorization"] = `Bearer ${currentAuthToken}`;
  }
  return fetch(url, options);
}

document.addEventListener("DOMContentLoaded", () => {
  checkCurrentUser();
  loadStatus();
  loadAccounts();
  initLogStream();
  // 5 秒自动轮询一次官方真实任务进度与保活心跳
  setInterval(() => {
    loadAccounts(true);
    loadStatus();
  }, 5000);
});

// 检查当前登录用户身份
async function checkCurrentUser() {
  const infoText = document.getElementById("user-info-text");
  const adminBtn = document.getElementById("btn-admin-users");
  const changePwdBtn = document.getElementById("btn-change-pwd");
  const authBtn = document.getElementById("btn-auth-action");
  const logPanel = document.getElementById("main-log-panel");
  const loggedActionsGroup = document.getElementById("logged-actions-group");
  const statsGrid = document.getElementById("main-stats-grid");
  const sectionHeader = document.getElementById("main-section-header");

  try {
    const res = await authFetch("/api/auth/me");
    const data = await res.json();

    if (data.isLoggedIn && data.user) {
      currentUser = data.user;
      const isAdmin = currentUser.role === "admin";
      infoText.innerHTML = `${isAdmin ? '👑 <b>管理员:</b> ' : '👤 <b>用户:</b> '}${escapeHtml(currentUser.username)}`;
      adminBtn.classList.toggle("hidden", !isAdmin);
      if (changePwdBtn) changePwdBtn.classList.remove("hidden");
      authBtn.innerText = "退出登录";
      authBtn.onclick = logoutUser;
      
      // 登录后展现全部业务区
      if (loggedActionsGroup) loggedActionsGroup.classList.remove("hidden");
      if (statsGrid) statsGrid.classList.remove("hidden");
      if (sectionHeader) sectionHeader.classList.remove("hidden");
      if (logPanel) logPanel.classList.remove("hidden");
      initLogStream();
    } else {
      currentUser = null;
      infoText.innerHTML = `未登录 (访客模式)`;
      adminBtn.classList.add("hidden");
      if (changePwdBtn) changePwdBtn.classList.add("hidden");
      authBtn.innerText = "登录/注册";
      authBtn.onclick = openAuthModal;
      
      // 未登录时隐藏所有业务区与控制台
      if (loggedActionsGroup) loggedActionsGroup.classList.add("hidden");
      if (statsGrid) statsGrid.classList.add("hidden");
      if (sectionHeader) sectionHeader.classList.add("hidden");
      if (logPanel) logPanel.classList.add("hidden");
    }
  } catch (e) {
    infoText.innerHTML = `系统在线`;
    if (loggedActionsGroup) loggedActionsGroup.classList.add("hidden");
    if (statsGrid) statsGrid.classList.add("hidden");
    if (sectionHeader) sectionHeader.classList.add("hidden");
    if (logPanel) logPanel.classList.add("hidden");
  }
}

// Toast 提示
function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerText = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 4000);
}

// 模态框辅助
function openModal(id) {
  document.getElementById(id).classList.remove("hidden");
}

function closeModal(id) {
  document.getElementById(id).classList.add("hidden");
}

// 1. 加载系统统计
async function loadStatus() {
  try {
    const res = await authFetch("/api/status");
    const data = await res.json();
    document.getElementById("stat-total").innerText = data.accountsTotal || 0;
    document.getElementById("stat-online").innerText = data.onlineKeepAlive || 0;
    document.getElementById("stat-signed").innerText = data.signedToday || 0;
  } catch (e) {
    console.error("加载状态异常:", e);
  }
}

// 2. 加载多账号列表
async function loadAccounts(isSilent = false) {
  try {
    const res = await authFetch("/api/accounts");
    accounts = await res.json();
    renderAccounts();
    if (!isSilent) loadStatus();
  } catch (e) {
    if (!isSilent) showToast("加载账号列表失败: " + e.message, "error");
  }
}

// 渲染账号卡片（包含权限阻断提示、真实官方任务看板与保活详细监视）
function renderAccounts() {
  const container = document.getElementById("accounts-container");
  container.innerHTML = "";

  // 如果未登录，严格阻断访客查看云电脑信息，只显示登录注册引导
  if (!currentUser) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 48px 24px; background: var(--bg-secondary); border-radius: var(--radius); border: 1px dashed var(--border); box-shadow: var(--shadow);">
        <div style="font-size: 40px; margin-bottom: 12px;">🔒</div>
        <h3 style="font-size: 17px; font-weight: 700; color: #0f172a; margin-bottom: 8px;">请登录后查看与管理云电脑</h3>
        <p style="font-size: 13.5px; color: var(--text-muted); max-width: 500px; margin: 0 auto 20px auto;">
          为保障账号隐私安全与多用户隔离，未登录访客无法查看或添加云电脑。请登录已有账号，或免费注册新账号开启独立后台。
        </p>
        <div style="display: flex; gap: 12px; justify-content: center;">
          <button class="btn btn-primary" onclick="openAuthModal('login')">🔑 立即登录</button>
          <button class="btn" onclick="openAuthModal('register')">✨ 免费注册新用户</button>
        </div>
      </div>
    `;
    return;
  }

  if (!accounts || accounts.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted); background: var(--bg-secondary); border-radius: var(--radius); border: 1px dashed var(--border);">
        <p style="font-size: 15px; margin-bottom: 12px;">当前账号下暂无配置云电脑</p>
        <button class="btn btn-primary" onclick="openAddAccountModal()">➕ 立即添加你的第一台云电脑</button>
      </div>
    `;
    return;
  }

  accounts.forEach(acc => {
    const card = document.createElement("div");
    card.className = "account-card";

    const isOnline = acc.stats?.keepAliveStatus === "online" || acc.liveMetrics?.status === "online";
    const statusBadge = isOnline
      ? `<span class="badge badge-online">🟢 保活长连接在线</span>`
      : `<span class="badge badge-offline">⚪ 未连接</span>`;

    const boundBadge = acc.bound
      ? `<span class="badge" style="background: rgba(22,163,74,0.12); color: #16a34a; border: 1px solid rgba(22,163,74,0.25);">已绑设备</span>`
      : `<span class="badge badge-warning" style="cursor: pointer;" onclick="openSmsModal('${acc.id}')">⚠️ 待短信绑定</span>`;

    const maskPhone = acc.user.replace(/(\d{3})\d{4}(\d{4})/, "$1****$2");
    const devCode = acc.deviceCode || "未生成";
    const f = acc.features || {};

    const m = acc.liveMetrics || {
      currentHost: '获取中...',
      desktopName: '云电脑',
      cycleCountdown: 60,
      keepAliveSeconds: 60,
      lastHeartbeatResult: '未建立会话',
      successCount: 0,
      officialTasks: [],
      userPoints: acc.stats?.points || 0
    };

    // 官方任务渲染（温润柔和配色）
    let officialTaskHtml = '';
    if (m.officialTasks && m.officialTasks.length > 0) {
      officialTaskHtml = m.officialTasks.map(t => {
        const isDone = t.status === 2 || (t.total > 0 && t.current >= t.total);
        const percent = Math.min(100, Math.round((t.current / (t.total || 1)) * 100));
        let progressText = `${t.current}/${t.total}`;
        if (t.name.includes('使用1小时')) {
          const mins = Math.floor(t.current / 60);
          progressText = `${mins}分钟 (${t.current}/3600秒)`;
        }

        return `
          <div style="background: #ffffff; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border); box-shadow: 0 1px 3px rgba(0,0,0,0.02);">
            <div style="display: flex; justify-content: space-between; font-size: 12.5px; margin-bottom: 6px;">
              <span>🎯 <b style="color:#0f172a;">${t.name}</b> <span style="color:#2563eb; font-weight:600;">(+${t.points}分)</span></span>
              <span style="color: ${isDone ? '#16a34a' : '#d97706'}; font-weight: 700;">
                ${isDone ? '✅ 已达成' : '⏳ ' + progressText}
              </span>
            </div>
            <div style="background: #e2e8f0; height: 6px; border-radius: 4px; overflow: hidden;">
              <div style="background: ${isDone ? '#16a34a' : '#2563eb'}; width: ${percent}%; height: 100%; transition: width 0.3s ease;"></div>
            </div>
          </div>
        `;
      }).join('');
    } else {
      officialTaskHtml = `<div style="font-size: 12px; color: var(--text-muted); text-align: center; padding: 6px 0;">正在同步天翼云官方任务中心数据...</div>`;
    }

    card.innerHTML = `
      <div class="card-top">
        <div class="account-main-info">
          <div class="account-avatar">${(acc.name || acc.user)[0].toUpperCase()}</div>
          <div class="account-name-block">
            <h3>
              ${escapeHtml(acc.name || acc.user)}
              ${statusBadge}
            </h3>
            <div class="account-phone">
              📱 ${maskPhone} &nbsp; ${boundBadge}
            </div>
          </div>
        </div>
        <div style="display: flex; gap: 4px;">
          <button class="btn btn-sm" onclick="editAccount('${acc.id}')" title="编辑账号">✏️</button>
          <button class="btn btn-sm btn-danger" onclick="deleteAccount('${acc.id}')" title="删除账号">🗑️</button>
        </div>
      </div>

      <!-- 设备码 -->
      <div class="device-box">
        <div style="display: flex; align-items: center; gap: 6px;">
          <span style="color: var(--text-muted);">设备:</span>
          <span class="device-code-text" title="${devCode}">${devCode}</span>
        </div>
        <button class="btn btn-sm" onclick="copyToClipboard('${devCode}')">复制</button>
      </div>

      <!-- 📡 真实 WebSocket 保活心跳状态监视 -->
      <div style="background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; font-size: 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <span style="color: #2563eb; font-weight: 700;">📡 长连接保活心跳详情</span>
          <span style="color: var(--text-muted);">周期: <b>${m.keepAliveSeconds || 60}s</b> (倒计时: <b style="color: #16a34a;">${m.cycleCountdown || 60}s</b>)</span>
        </div>
        <div style="color: #475569; line-height: 1.7;">
          <div>目标设备: <span style="color: #0f172a; font-weight: 600;">${escapeHtml(m.desktopName || '云电脑')} (${m.currentHost || '未连接'})</span></div>
          <div>保活动作: <span style="color: #16a34a; font-weight: 600;">${escapeHtml(m.lastHeartbeatResult || '正在建立心跳通道...')}</span></div>
          <div>成功次数: <span style="color: #2563eb; font-weight: 600;">${m.successCount || 0} 轮次</span></div>
        </div>
      </div>

      <!-- 🏆 天翼云官方真实任务看板 (实时拉取官方数据) -->
      <div style="display: flex; flex-direction: column; gap: 6px;">
        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 13px; font-weight: 700;">
          <span style="color: #b45309;">🏆 官方任务中心实时进度</span>
          <span style="color: #16a34a;">当前总积分: <b style="font-size:14px;">${m.userPoints || 0}</b></span>
        </div>
        ${officialTaskHtml}
      </div>

      <!-- 功能开关 -->
      <div class="features-box">
        <div class="feature-row">
          <span>📡 启用云电脑保活 (60s周期长连接守护)</span>
          <label class="switch">
            <input type="checkbox" ${f.keepAlive !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'keepAlive', this.checked)">
            <span class="slider"></span>
          </label>
        </div>
        <div class="feature-row">
          <span>📅 每日自动签到打卡</span>
          <label class="switch">
            <input type="checkbox" ${f.autoSign !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'autoSign', this.checked)">
            <span class="slider"></span>
          </label>
        </div>
        <div class="feature-row">
          <span>🤖 AI 智能对话任务 (每日100分)</span>
          <label class="switch">
            <input type="checkbox" ${f.aiChat !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'aiChat', this.checked)">
            <span class="slider"></span>
          </label>
        </div>
        <div class="feature-row">
          <span>⏱️ 云电脑挂机1小时 (每日100分)</span>
          <label class="switch">
            <input type="checkbox" ${f.cloudHang !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'cloudHang', this.checked)">
            <span class="slider"></span>
          </label>
        </div>
        <div class="feature-row">
          <span>🎁 自动兑换/抽奖 (${acc.redeemConfig?.enabled ? '<b style=\"color:#16a34a\">已开</b>' : '未开'})</span>
          <button class="btn btn-sm btn-warning" onclick="openRedeemModal('${acc.id}')">⚙️ 奖品与抽奖设置</button>
        </div>
      </div>

      <!-- 快捷操作按钮 -->
      <div class="card-actions">
        <button class="btn btn-sm btn-success" onclick="triggerTask('${acc.id}', 'sign')">立即打卡</button>
        <button class="btn btn-sm btn-primary" onclick="triggerTask('${acc.id}', 'aiChat')">立即AI对话</button>
        <button class="btn btn-sm" onclick="triggerTask('${acc.id}', 'hang')">立即挂机同步</button>
        <button class="btn btn-sm" onclick="openDisplayModal('${acc.id}')" title="设置云电脑分辨率与缩放比">🖥️ 分辨率: ${acc.displayConfig?.width || 2560}*${acc.displayConfig?.height || 1440} (${acc.displayConfig?.scale || 150}%)</button>
        ${!acc.bound ? `<button class="btn btn-sm btn-warning" onclick="openSmsModal('${acc.id}')">📲 短信绑定</button>` : ''}
      </div>
    `;

    container.appendChild(card);
  });
}

// 快速切换开关
async function toggleFeature(accId, featureKey, checked) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  acc.features = acc.features || {};
  acc.features[featureKey] = checked;

  try {
    const res = await fetch(`/api/accounts/${accId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ features: acc.features })
    });
    if (res.ok) {
      showToast(`已${checked ? '开启' : '关闭'}该功能`, "success");
    } else {
      showToast("更新失败", "error");
    }
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
  }
}

// 3. 添加/编辑账号
function openAddAccountModal() {
  document.getElementById("modal-account-title").innerText = "添加天翼云账号";
  document.getElementById("acc-id").value = "";
  document.getElementById("acc-name").value = "";
  document.getElementById("acc-user").value = "";
  document.getElementById("acc-password").value = "";
  document.getElementById("acc-device-code").value = "";
  openModal("account-modal");
}

function editAccount(accId) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  document.getElementById("modal-account-title").innerText = "编辑天翼云账号";
  document.getElementById("acc-id").value = acc.id;
  document.getElementById("acc-name").value = acc.name || "";
  document.getElementById("acc-user").value = acc.user || "";
  document.getElementById("acc-password").value = acc.password || "";
  document.getElementById("acc-device-code").value = acc.deviceCode || "";
  openModal("account-modal");
}

async function generateNewDeviceCode() {
  try {
    const res = await fetch("/api/device/generate", { method: "POST" });
    const data = await res.json();
    document.getElementById("acc-device-code").value = data.deviceCode;
    showToast("已重新生成设备码", "info");
  } catch (e) {
    showToast("生成失败", "error");
  }
}

async function saveAccount() {
  const accId = document.getElementById("acc-id").value;
  const name = document.getElementById("acc-name").value.trim();
  const user = document.getElementById("acc-user").value.trim();
  const password = document.getElementById("acc-password").value.trim();
  const deviceCode = document.getElementById("acc-device-code").value.trim();

  if (!user || !password) {
    showToast("手机号/账号与密码不能为空", "error");
    return;
  }

  showToast("正在向天翼云发起真实登录验证，请稍候...", "info");

  const payload = { name: name || user, user, password, deviceCode };

  try {
    let res;
    if (accId) {
      res = await authFetch(`/api/accounts/${accId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } else {
      res = await authFetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    }

    const data = await res.json();
    if (res.ok) {
      closeModal("account-modal");
      showToast(accId ? "账号更新成功！" : "🎉 账号真实验证成功，已添加并启动保活！", "success");
      checkCurrentUser();
      loadAccounts();
    } else {
      showToast("❌ 操作未通过: " + (data.error || "用户名或密码错误"), "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

async function deleteAccount(accId) {
  const acc = accounts.find(a => a.id === accId);
  if (!confirm(`确定要删除账号 [${acc?.name || acc?.user}] 吗？`)) return;

  try {
    const res = await authFetch(`/api/accounts/${accId}`, { method: "DELETE" });
    if (res.ok) {
      showToast("账号已删除", "success");
      checkCurrentUser();
      loadAccounts();
    } else {
      showToast("删除失败", "error");
    }
  } catch (e) {
    showToast("网络异常", "error");
  }
}

// 4. 短信验证码绑定设备
function openSmsModal(accId) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  document.getElementById("sms-acc-id").value = acc.id;
  document.getElementById("sms-phone").value = acc.user;
  document.getElementById("sms-code").value = "";
  openModal("sms-modal");
}

let smsCountdown = 0;
async function sendSmsCode() {
  const accId = document.getElementById("sms-acc-id").value;
  const btn = document.getElementById("btn-send-sms");
  if (smsCountdown > 0) return;

  btn.innerText = "发送中...";
  btn.disabled = true;

  try {
    const res = await authFetch(`/api/accounts/${accId}/send-sms`, { method: "POST" });
    const data = await res.json();
    if (res.ok) {
      showToast("验证码发送成功，请查收手机短信", "success");
      smsCountdown = 60;
      const timer = setInterval(() => {
        smsCountdown--;
        if (smsCountdown <= 0) {
          clearInterval(timer);
          btn.innerText = "获取验证码";
          btn.disabled = false;
        } else {
          btn.innerText = `重新获取(${smsCountdown}s)`;
        }
      }, 1000);
    } else {
      showToast("发送短信失败: " + (data.message || data.error), "error");
      btn.innerText = "获取验证码";
      btn.disabled = false;
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
    btn.innerText = "获取验证码";
    btn.disabled = false;
  }
}

async function submitSmsBind() {
  const accId = document.getElementById("sms-acc-id").value;
  const code = document.getElementById("sms-code").value.trim();

  if (!code) {
    showToast("请输入短信验证码", "error");
    return;
  }

  try {
    const res = await authFetch(`/api/accounts/${accId}/bind-sms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verificationCode: code })
    });
    const data = await res.json();
    if (res.ok) {
      showToast("设备绑定成功！保活已就绪", "success");
      closeModal("sms-modal");
      loadAccounts();
    } else {
      showToast("绑定失败: " + (data.message || data.error), "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

// 5. 自动兑换与抽奖设置
async function openRedeemModal(accId) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  document.getElementById("redeem-acc-id").value = acc.id;

  const cfg = acc.redeemConfig || {};
  document.getElementById("redeem-enabled").checked = !!cfg.enabled;
  document.getElementById("redeem-enabled-label").innerText = cfg.enabled ? "已启用自动兑换" : "未启用";

  document.getElementById("redeem-target-type").value = cfg.targetType || "redeem";
  document.getElementById("redeem-schedule-type").value = cfg.scheduleType || "monthly_days";
  document.getElementById("redeem-monthly-days").value = (cfg.monthlyDays || [-1]).join(",");
  document.getElementById("redeem-interval-days").value = cfg.intervalDays || 1;
  document.getElementById("redeem-max-times").value = cfg.maxRedeemTimes || 0;

  onScheduleTypeChange();
  onTargetTypeChange();

  await loadProductList(cfg.prodId);
  loadAccountDesktops(accId, cfg.desktopId);

  openModal("redeem-modal");
}

document.getElementById("redeem-enabled")?.addEventListener("change", (e) => {
  document.getElementById("redeem-enabled-label").innerText = e.target.checked ? "已启用自动兑换" : "未启用";
});

async function loadProductList(selectedProdId) {
  const select = document.getElementById("redeem-product-select");
  select.innerHTML = "<option value=''>正在连接天翼云商城拉取最新奖品...</option>";

  try {
    const res = await authFetch("/api/rewards");
    availableRewards = await res.json();

    select.innerHTML = "";
    availableRewards.forEach(r => {
      const opt = document.createElement("option");
      opt.value = r.prodId;
      opt.innerText = `${r.prodName} (${r.costPoints} 积分)`;
      opt.dataset.name = r.prodName;
      opt.dataset.points = r.costPoints;
      opt.dataset.type = r.prodType;
      if (selectedProdId && Number(selectedProdId) === Number(r.prodId)) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });
  } catch (e) {
    select.innerHTML = "<option value='17023101'>8C16G升配包1天 (500积分)</option>";
  }
}

async function loadAccountDesktops(accId, selectedDesktopId) {
  const select = document.getElementById("redeem-desktop-select");
  select.innerHTML = "<option value=''>正在获取绑定的云电脑...</option>";

  try {
    const res = await authFetch(`/api/accounts/${accId}/desktops`);
    if (res.ok) {
      const list = await res.json();
      if (list.length > 0) {
        select.innerHTML = "";
        list.forEach(d => {
          const opt = document.createElement("option");
          opt.value = d.desktopId;
          opt.innerText = `${d.desktopName || d.desktopCode} (${d.useStatusText || '云电脑'})`;
          if (selectedDesktopId && String(selectedDesktopId) === String(d.desktopId)) {
            opt.selected = true;
          }
          select.appendChild(opt);
        });
        return;
      }
    }
  } catch (e) {}

  select.innerHTML = "<option value='default'>默认主云电脑</option>";
}

function onTargetTypeChange() {
  const type = document.getElementById("redeem-target-type").value;
  const desktopGroup = document.getElementById("group-desktop-select");
  if (type === "lottery") {
    desktopGroup.classList.add("hidden");
  } else {
    desktopGroup.classList.remove("hidden");
  }
}

function onScheduleTypeChange() {
  const type = document.getElementById("redeem-schedule-type").value;
  document.getElementById("group-monthly-days").classList.toggle("hidden", type !== "monthly_days");
  document.getElementById("group-interval-days").classList.toggle("hidden", type !== "interval_days");
}

async function saveRedeemConfig() {
  const accId = document.getElementById("redeem-acc-id").value;
  const enabled = document.getElementById("redeem-enabled").checked;
  const targetType = document.getElementById("redeem-target-type").value;
  const prodSelect = document.getElementById("redeem-product-select");
  const selectedOpt = prodSelect.options[prodSelect.selectedIndex];

  const desktopSelect = document.getElementById("redeem-desktop-select");
  const desktopId = desktopSelect.value;
  const desktopName = desktopSelect.options[desktopSelect.selectedIndex]?.innerText || "";

  const scheduleType = document.getElementById("redeem-schedule-type").value;
  const monthlyStr = document.getElementById("redeem-monthly-days").value.trim();
  const monthlyDays = monthlyStr.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  const intervalDays = parseInt(document.getElementById("redeem-interval-days").value) || 1;
  const maxTimes = parseInt(document.getElementById("redeem-max-times").value) || 0;

  const redeemConfig = {
    enabled,
    targetType,
    prodId: selectedOpt ? parseInt(selectedOpt.value) : 17023101,
    prodName: selectedOpt ? selectedOpt.dataset.name : "8C16G升配包1天",
    prodType: selectedOpt ? selectedOpt.dataset.type : "pointstplupgrade",
    costPoints: selectedOpt ? parseInt(selectedOpt.dataset.points) : 500,
    desktopId,
    desktopName,
    scheduleType,
    monthlyDays: monthlyDays.length > 0 ? monthlyDays : [-1],
    intervalDays,
    maxRedeemTimes: maxTimes
  };

  try {
    const res = await authFetch(`/api/accounts/${accId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        features: { autoRedeem: enabled },
        redeemConfig
      })
    });
    if (res.ok) {
      showToast("自动兑换与抽奖配置已保存！", "success");
      closeModal("redeem-modal");
      loadAccounts();
    } else {
      showToast("保存配置失败", "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

// 6. 手动触发真实任务
async function triggerTask(accId, taskType) {
  const acc = accounts.find(a => a.id === accId);
  const taskNames = { sign: "签到打卡", aiChat: "AI智能对话", hang: "云电脑挂机", redeem: "自动兑换检查" };
  const name = taskNames[taskType] || taskType;

  showToast(`正在向天翼云下发 [${acc?.name}] 的${name}指令并同步真实进度...`, "info");
  try {
    const res = await authFetch(`/api/accounts/${accId}/run/${taskType}`, { method: "POST" });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || `[${name}] 执行成功，官方状态已刷新！`, "success");
      setTimeout(() => loadAccounts(true), 1500);
    } else {
      showToast("触发失败: " + (data.error || "未知异常"), "error");
    }
  } catch (e) {
    showToast("网络异常: " + e.message, "error");
  }
}

// 7. 重启保活守护
async function restartKeeper() {
  if (!confirm("确定要平滑重置所有云电脑保活守护通道吗？")) return;
  showToast("正在重置保活通道...", "info");
  try {
    await authFetch("/api/keeper/restart", { method: "POST" });
    showToast("指令已发送，保活长连接已重新建立", "success");
  } catch (e) {
    showToast("发送指令失败", "error");
  }
}

// 8. 全局系统设置
async function openSettingsModal() {
  try {
    const res = await authFetch("/api/settings");
    const settings = await res.json();

    const c = settings.cron || {};
    document.getElementById("cron-sign").value = c.signCron || "0 2 * * *";
    document.getElementById("cron-aichat").value = c.aiChatCron || "0 3,20 * * *";
    document.getElementById("cron-hang").value = c.cloudHangCron || "0 4,6 * * *";
    document.getElementById("cron-redeem").value = c.redeemCron || "0 7 * * *";

    document.getElementById("set-keepalive-sec").value = settings.keepAliveSeconds || 60;
    if (document.getElementById("set-allow-reg")) {
      document.getElementById("set-allow-reg").checked = settings.allowRegistration !== false;
    }
    if (document.getElementById("set-default-quota")) {
      document.getElementById("set-default-quota").value = settings.defaultQuota || 2;
    }

    const n = settings.notify || {};
    document.getElementById("notify-enabled").checked = !!n.enabled;
    document.getElementById("notify-channel").value = n.channel || "webhook";
    document.getElementById("notify-token").value = n.webhookUrl || "";
    document.getElementById("notify-title-tpl").value = n.customTitleTemplate || "";
    document.getElementById("notify-content-tpl").value = n.customContentTemplate || "";
    onNotifyChannelChange();

    openModal("settings-modal");
  } catch (e) {
    showToast("获取设置失败", "error");
  }
}

async function testNotification() {
  const channel = document.getElementById("notify-channel").value;
  const webhookUrl = document.getElementById("notify-token").value.trim();
  const customTitleTemplate = document.getElementById("notify-title-tpl").value.trim();
  const customContentTemplate = document.getElementById("notify-content-tpl").value.trim();

  if (!webhookUrl) {
    showToast("请先输入推送地址或 Token", "error");
    return;
  }

  showToast("正在发送测试推送...", "info");
  try {
    const res = await authFetch("/api/notify/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, webhookUrl, customTitleTemplate, customContentTemplate })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("🎉 推送成功！已向你的通道发送测试卡片", "success");
    } else {
      showToast(`推送失败: ${data.message || '网络无法连通'}`, "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

function onNotifyChannelChange() {
  const channel = document.getElementById("notify-channel").value;
  const label = document.getElementById("notify-token-label");
  const input = document.getElementById("notify-token");

  if (channel === "qywx") {
    label.innerText = "企业微信机器人 Webhook 地址";
    input.placeholder = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx";
  } else if (channel === "serverchan") {
    label.innerText = "Server酱 SendKey";
    input.placeholder = "请输入 SendKey";
  } else if (channel === "pushplus") {
    label.innerText = "PushPlus Token";
    input.placeholder = "请输入 PushPlus Token";
  } else if (channel === "bark") {
    label.innerText = "Bark 推送完整 URL";
    input.placeholder = "例如 https://api.day.app/你的Key";
  } else if (channel === "telegram") {
    label.innerText = "TG BotToken (格式: token@chatId)";
    input.placeholder = "BotToken@ChatId";
  } else {
    label.innerText = "自定义 Webhook URL";
    input.placeholder = "https://example.com/webhook";
  }
}

async function saveSettings() {
  const payload = {
    keepAliveSeconds: parseInt(document.getElementById("set-keepalive-sec").value) || 60,
    allowRegistration: document.getElementById("set-allow-reg") ? document.getElementById("set-allow-reg").checked : true,
    defaultQuota: document.getElementById("set-default-quota") ? parseInt(document.getElementById("set-default-quota").value) || 2 : 2,
    cron: {
      signCron: document.getElementById("cron-sign").value.trim(),
      aiChatCron: document.getElementById("cron-aichat").value.trim(),
      cloudHangCron: document.getElementById("cron-hang").value.trim(),
      redeemCron: document.getElementById("cron-redeem").value.trim()
    },
    notify: {
      enabled: document.getElementById("notify-enabled").checked,
      channel: document.getElementById("notify-channel").value,
      webhookUrl: document.getElementById("notify-token").value.trim(),
      customTitleTemplate: document.getElementById("notify-title-tpl").value.trim(),
      customContentTemplate: document.getElementById("notify-content-tpl").value.trim()
    }
  };

  try {
    const res = await authFetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      showToast("系统设置已更新！Webhook 已生效", "success");
      closeModal("settings-modal");
    } else {
      showToast("更新失败", "error");
    }
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
  }
}
// 9. 实时控制台日志与分类过滤
let allReceivedLogs = [];
let activeLogFilter = 'tasks'; // 默认优先聚焦任务反馈，避免被心跳淹没

function switchLogFilter(filterType) {
  activeLogFilter = filterType;
  document.getElementById('tab-tasks').className = filterType === 'tasks' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  document.getElementById('tab-heartbeat').className = filterType === 'heartbeat' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  document.getElementById('tab-all').className = filterType === 'all' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  renderFilteredLogs();
}

function renderFilteredLogs() {
  const logBox = document.getElementById("log-content");
  logBox.innerHTML = "";
  const filtered = allReceivedLogs.filter(item => {
    if (activeLogFilter === 'all') return true;
    if (activeLogFilter === 'heartbeat') return item.source === 'Heartbeat';
    if (activeLogFilter === 'tasks') return item.source !== 'Heartbeat';
    return true;
  });

  if (filtered.length === 0) {
    logBox.innerHTML = `<div class="log-line" style="color: #64748b;">[暂无此类日志]</div>`;
    return;
  }

  filtered.forEach(item => {
    const line = document.createElement("div");
    line.className = `log-line log-level-${item.level || 'info'}`;
    line.innerHTML = `
      <span class="log-time">[${item.timestamp}]</span>
      <span class="log-source">[${item.source}]</span>
      <span>${escapeHtml(item.message)}</span>
    `;
    logBox.appendChild(line);
  });

  if (autoScroll) logBox.scrollTop = logBox.scrollHeight;
}

async function initLogStream() {
  const statusSpan = document.getElementById("log-status");

  // 未登录时直接不连接日志，保持静默
  if (!currentAuthToken) {
    statusSpan.innerText = "未登录";
    statusSpan.style.color = "#64748b";
    return;
  }

  // 先通过带 Token 的请求主动拉取历史日志
  try {
    const res = await authFetch('/api/logs');
    if (res.ok) {
      const history = await res.json();
      if (Array.isArray(history) && history.length > 0) {
        allReceivedLogs = history;
        renderFilteredLogs();
      }
    }
  } catch (e) {}

  if (eventSource) {
    eventSource.close();
  }

  // SSE URL 携带 Token，确保服务端安全通过鉴权并精准分发日志
  const sseUrl = `/api/logs/stream?token=${encodeURIComponent(currentAuthToken)}`;
  eventSource = new EventSource(sseUrl);

  eventSource.onopen = () => {
    statusSpan.innerText = "实时连接中";
    statusSpan.style.color = "#16a34a";
  };

  eventSource.onmessage = (e) => {
    try {
      const item = JSON.parse(e.data);
      allReceivedLogs.push(item);
      if (allReceivedLogs.length > 3000) allReceivedLogs.shift();

      // 判断是否符合当前筛选条件
      let match = true;
      if (activeLogFilter === 'heartbeat' && item.source !== 'Heartbeat') match = false;
      if (activeLogFilter === 'tasks' && item.source === 'Heartbeat') match = false;

      if (match) {
        const logBox = document.getElementById("log-content");
        const line = document.createElement("div");
        line.className = `log-line log-level-${item.level || 'info'}`;
        line.innerHTML = `
          <span class="log-time">[${item.timestamp}]</span>
          <span class="log-source">[${item.source}]</span>
          <span>${escapeHtml(item.message)}</span>
        `;
        logBox.appendChild(line);
        if (autoScroll) logBox.scrollTop = logBox.scrollHeight;
      }
    } catch (err) {}
  };

  eventSource.onerror = (err) => {
    // 区分是未登录还是网络暂时断开
    if (!currentUser) {
      statusSpan.innerText = "未登录";
      statusSpan.style.color = "#64748b";
    } else {
      statusSpan.innerText = "心跳保持正常 (网络待命中)";
      statusSpan.style.color = "#16a34a";
    }
  };
}

function clearLogs() {
  allReceivedLogs = [];
  document.getElementById("log-content").innerHTML = "";
  showToast("日志已清屏", "info");
}

function toggleAutoScroll() {
  autoScroll = !autoScroll;
  document.getElementById("btn-autoscroll").innerText = `自动滚动: ${autoScroll ? '开' : '关'}`;
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast("设备码已复制到剪贴板", "success");
  }).catch(() => {
    showToast("复制失败，请手动复制", "error");
  });
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ==========================================
// 配置备份与还原 (JSON 导入/导出)
// ==========================================
function openBackupModal() {
  if (!currentAuthToken) {
    showToast("请先登录后再进行配置备份与还原", "error");
    openAuthModal();
    return;
  }
  document.getElementById("import-file-name").innerText = "未选择文件";
  document.getElementById("import-file-input").value = "";
  openModal("backup-modal");
}

async function exportConfigJson() {
  try {
    showToast("正在导出配置...", "info");
    const res = await authFetch("/api/config/export");
    if (!res.ok) throw new Error("导出失败");
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ctyun_config_backup_${new Date().toISOString().substring(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
    showToast("🎉 配置备份文件已成功下载！", "success");
  } catch (e) {
    showToast("导出失败: " + e.message, "error");
  }
}

function handleFileSelected(input) {
  if (!input.files || input.files.length === 0) return;
  const file = input.files[0];
  document.getElementById("import-file-name").innerText = file.name;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const json = JSON.parse(e.target.result);
      if (!json.accounts || !Array.isArray(json.accounts)) {
        showToast("文件格式错误：未找到 accounts 账号列表", "error");
        return;
      }
      const mode = document.getElementById("import-mode-select").value;
      const count = json.accounts.length;
      if (!confirm(`检测到文件中包含 ${count} 个云电脑账号，确认使用【${mode === 'merge' ? '增量合并' : '完全覆盖'}】模式导入吗？`)) {
        return;
      }

      showToast("正在解析并导入账号配置...", "info");
      const res = await authFetch("/api/config/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...json, mode })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(data.message || "导入成功！已自动上线长连接保活", "success");
        closeModal("backup-modal");
        await loadAccounts();
      } else {
        showToast("导入失败: " + (data.error || "未知异常"), "error");
      }
    } catch (err) {
      showToast("JSON 解析失败: " + err.message, "error");
    }
  };
  reader.readAsText(file);
}

// ==========================================
// 多用户系统与管理员配额控制
// ==========================================
let authMode = "login";

function openAuthModal() {
  document.getElementById("auth-username").value = "";
  document.getElementById("auth-password").value = "";
  switchAuthMode("login");
  openModal("auth-modal");
}

function switchAuthMode(mode) {
  authMode = mode;
  const isLogin = mode === "login";
  document.getElementById("auth-modal-title").innerText = isLogin ? "用户登录" : "新用户注册";
  document.getElementById("btn-auth-tab-login").className = isLogin ? "btn btn-sm btn-primary" : "btn btn-sm";
  document.getElementById("btn-auth-tab-reg").className = !isLogin ? "btn btn-sm btn-primary" : "btn btn-sm";
  document.getElementById("btn-auth-submit").innerText = isLogin ? "立即登录" : "立即注册并登录";
  const tipEle = document.getElementById("auth-tip");
  if (tipEle) tipEle.innerText = "";
}

async function submitAuth() {
  const username = document.getElementById("auth-username").value.trim();
  const password = document.getElementById("auth-password").value.trim();

  if (!username || !password) {
    showToast("请输入用户名和密码", "error");
    return;
  }

  const endpoint = authMode === "login" ? "/api/auth/login" : "/api/auth/register";

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (res.ok && data.success) {
      currentAuthToken = data.token;
      localStorage.setItem("ctyun_auth_token", data.token);
      showToast(authMode === "login" ? `欢迎回来，${data.user.username}！` : `注册成功，欢迎加入！`, "success");
      closeModal("auth-modal");
      await checkCurrentUser();
      await loadAccounts();
      initLogStream();
    } else {
      showToast(data.error || "操作失败", "error");
    }
  } catch (e) {
    showToast("请求网络异常: " + e.message, "error");
  }
}

function logoutUser() {
  currentAuthToken = "";
  localStorage.removeItem("ctyun_auth_token");
  currentUser = null;
  showToast("已安全退出登录", "info");
  checkCurrentUser();
  loadAccounts();
}

// 打开管理员用户配额管理模态框
async function openAdminUsersModal() {
  const tbody = document.getElementById("admin-users-tbody");
  tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:12px; color:var(--text-muted);">正在加载用户列表...</td></tr>`;
  openModal("admin-users-modal");

  try {
    const res = await authFetch("/api/admin/users");
    if (!res.ok) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--danger); padding:12px;">权限不足或获取用户列表失败</td></tr>`;
      return;
    }
    const users = await res.json();
    tbody.innerHTML = "";

    users.forEach(u => {
      const tr = document.createElement("tr");
      tr.style.borderBottom = "1px solid var(--border)";
      const isAdmin = u.role === "admin";

      tr.innerHTML = `
        <td style="padding: 10px 8px; font-weight: 600;">${escapeHtml(u.username)}</td>
        <td style="padding: 10px 8px;">
          <span class="badge ${isAdmin ? 'badge-online' : 'badge-offline'}">${isAdmin ? '超级管理员' : '普通用户'}</span>
        </td>
        <td style="padding: 10px 8px; font-weight: 600; color: #38bdf8;">${u.accountsCount || 0} 台</td>
        <td style="padding: 10px 8px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <input type="number" class="form-control" style="width: 80px; padding: 4px 8px; font-size: 12px;" id="quota-input-${u.id}" value="${u.maxQuota || 2}" min="0">
            <button class="btn btn-sm btn-primary" onclick="saveUserQuota('${u.id}')">保存配额</button>
          </div>
        </td>
        <td style="padding: 10px 8px;">
          <div style="display: flex; gap: 4px;">
            <button class="btn btn-sm" onclick="openAdminSetPwdModal('${u.id}', '${u.username}')">修改密码</button>
            ${!isAdmin ? `<button class="btn btn-sm btn-danger" onclick="deleteUserAccount('${u.id}', '${u.username}')">删除</button>` : ''}
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--danger); padding:12px;">加载异常: ${e.message}</td></tr>`;
  }
}

async function saveUserQuota(userId) {
  const input = document.getElementById(`quota-input-${userId}`);
  const quota = parseInt(input.value) || 0;

  try {
    const res = await authFetch(`/api/admin/users/${userId}/quota`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxQuota: quota })
    });
    if (res.ok) {
      showToast(`已成功将该用户的云电脑添加配额设置为 ${quota} 台！`, "success");
      checkCurrentUser();
    } else {
      showToast("设置配额失败", "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

async function deleteUserAccount(userId, username) {
  if (!confirm(`确定要删除普通用户 [${username}] 吗？`)) return;

  try {
    const res = await authFetch(`/api/admin/users/${userId}`, { method: "DELETE" });
    if (res.ok) {
      showToast("用户已删除", "success");
      openAdminUsersModal();
    } else {
      showToast("删除失败", "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

// 修改个人密码
function openChangePwdModal() {
  document.getElementById("new-user-pwd").value = "";
  document.getElementById("confirm-user-pwd").value = "";
  openModal("change-pwd-modal");
}

async function submitChangePassword() {
  const p1 = document.getElementById("new-user-pwd").value.trim();
  const p2 = document.getElementById("confirm-user-pwd").value.trim();

  if (!p1 || p1.length < 5) {
    showToast("新密码长度不能少于5位", "error");
    return;
  }
  if (p1 !== p2) {
    showToast("两次输入的新密码不一致", "error");
    return;
  }

  try {
    const res = await authFetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword: p1 })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("密码修改成功，请牢记新密码！", "success");
      closeModal("change-pwd-modal");
    } else {
      showToast(data.error || "修改失败", "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

// 管理员修改其他用户密码
function openAdminSetPwdModal(userId, username) {
  document.getElementById("admin-edit-user-id").value = userId;
  document.getElementById("admin-edit-username").value = username;
  document.getElementById("admin-set-new-pwd").value = "";
  openModal("admin-user-pwd-modal");
}

async function submitAdminUserPassword() {
  const userId = document.getElementById("admin-edit-user-id").value;
  const newPassword = document.getElementById("admin-set-new-pwd").value.trim();

  if (!newPassword || newPassword.length < 5) {
    showToast("密码长度至少5位", "error");
    return;
  }

  try {
    const res = await authFetch(`/api/admin/users/${userId}/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("指定用户密码已成功更新！", "success");
      closeModal("admin-user-pwd-modal");
    } else {
      showToast(data.error || "更新失败", "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

// 分辨率与缩放设置
function openDisplayModal(accId) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  document.getElementById("display-acc-id").value = acc.id;

  const d = acc.displayConfig || { width: 2560, height: 1440, scale: 150 };
  document.getElementById("disp-width").value = d.width || 2560;
  document.getElementById("disp-height").value = d.height || 1440;
  document.getElementById("disp-scale").value = d.scale || 150;

  // 匹配预设
  const presetKey = `${d.width}x${d.height}@${d.scale}`;
  const select = document.getElementById("display-preset-select");
  let matched = false;
  for (let i = 0; i < select.options.length; i++) {
    if (select.options[i].value === presetKey) {
      select.selectedIndex = i;
      matched = true;
      break;
    }
  }
  if (!matched) select.value = "custom";

  openModal("display-modal");
}

function onDisplayPresetChange() {
  const val = document.getElementById("display-preset-select").value;
  if (val === "custom") return;
  const [res, scaleStr] = val.split("@");
  const [w, h] = res.split("x");
  document.getElementById("disp-width").value = parseInt(w);
  document.getElementById("disp-height").value = parseInt(h);
  document.getElementById("disp-scale").value = parseInt(scaleStr);
}

async function saveDisplayConfig() {
  const accId = document.getElementById("display-acc-id").value;
  const width = parseInt(document.getElementById("disp-width").value) || 2560;
  const height = parseInt(document.getElementById("disp-height").value) || 1440;
  const scale = parseInt(document.getElementById("disp-scale").value) || 150;

  try {
    const res = await authFetch(`/api/accounts/${accId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayConfig: { width, height, scale }
      })
    });
    if (res.ok) {
      showToast(`云电脑已锁定为 ${width}×${height} 缩放 ${scale}%！`, "success");
      closeModal("display-modal");
      loadAccounts();
    } else {
      showToast("保存分辨率设置失败", "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}
