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
  allReceivedLogs = [];
  const logBox = document.getElementById("log-content");
  if (logBox) logBox.innerHTML = "";
  checkCurrentUser();
  loadStatus();
  loadAccounts();
  // 5 秒自动轮询一次官方真实任务进度与保活心跳
  setInterval(() => {
    loadAccounts(true);
    loadStatus();
  }, 5000);

  // 窗口重获焦点时（例如关闭云电脑弹窗回到控制台主页），立即秒级同步最新开关与机器状态
  window.addEventListener("focus", () => {
    loadAccounts(true);
    loadStatus();
  });

  // 监听登录弹窗中的回车键，按回车直接提交登录！
  const authInputs = [document.getElementById("auth-username"), document.getElementById("auth-password")];
  authInputs.forEach(el => {
    if (el) {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submitAuth();
        }
      });
    }
  });
});

// 头像下拉菜单控制
function toggleUserMenu() {
  const menu = document.getElementById("user-dropdown-menu");
  if (menu) menu.classList.toggle("hidden");
  hideSettingsMenu();
}

function hideUserMenu() {
  const menu = document.getElementById("user-dropdown-menu");
  if (menu) menu.classList.add("hidden");
}

// 系统设置下拉菜单控制
function toggleSettingsMenu() {
  const menu = document.getElementById("settings-dropdown-menu");
  if (menu) menu.classList.toggle("hidden");
  hideUserMenu();
}

function hideSettingsMenu() {
  const menu = document.getElementById("settings-dropdown-menu");
  if (menu) menu.classList.add("hidden");
}

// 点击页面其他区域自动收起所有下拉菜单
document.addEventListener("click", (e) => {
  const userContainer = document.getElementById("user-dropdown-container");
  if (userContainer && !userContainer.contains(e.target)) {
    hideUserMenu();
  }
  const settingsContainer = document.getElementById("settings-dropdown-container");
  if (settingsContainer && !settingsContainer.contains(e.target)) {
    hideSettingsMenu();
  }
});

// 检查当前登录用户身份
async function checkCurrentUser() {
  const authBtn = document.getElementById("btn-auth-action");
  const logPanel = document.getElementById("main-log-panel");
  const loggedActionsGroup = document.getElementById("logged-actions-group");
  const statsGrid = document.getElementById("main-stats-grid");
  const sectionHeader = document.getElementById("main-section-header");
  const headerAvatar = document.getElementById("header-avatar");
  const dropdownUsername = document.getElementById("dropdown-username");
  const menuAdminUsers = document.getElementById("menu-admin-users");

  // 如果本地有持久化凭据，提前恢复界面，消除刷新时 1~2 秒由于异步网络导致的“白屏返回登录界面”闪烁等待！
  if (currentAuthToken) {
    if (authBtn) authBtn.classList.add("hidden");
    if (loggedActionsGroup) loggedActionsGroup.classList.remove("hidden");
    if (statsGrid) statsGrid.classList.remove("hidden");
    if (sectionHeader) sectionHeader.classList.remove("hidden");
    if (logPanel) logPanel.classList.remove("hidden");
  }

  try {
    const res = await authFetch("/api/auth/me");
    const data = await res.json();

    // 动态同步主标题名称
    if (data.systemTitle) {
      const titleEl = document.getElementById("main-system-title");
      if (titleEl) titleEl.innerText = data.systemTitle;
      document.title = `${data.systemTitle} - 多账号保活控制台`;
    }

    if (data.isLoggedIn && data.user) {
      currentUser = data.user;
      const isAdmin = currentUser.role === "admin";
      
      // 更新头像首字母和下拉菜单用户名
      const initial = (currentUser.username || "A")[0].toUpperCase();
      if (headerAvatar) headerAvatar.innerText = initial;
      if (dropdownUsername) dropdownUsername.innerText = `${currentUser.username} (${isAdmin ? '管理员' : '普通用户'})`;
      if (menuAdminUsers) menuAdminUsers.classList.toggle("hidden", !isAdmin);

      // 未登录按钮隐藏，已登录整组展开
      if (authBtn) authBtn.classList.add("hidden");
      if (loggedActionsGroup) loggedActionsGroup.classList.remove("hidden");
      if (statsGrid) statsGrid.classList.remove("hidden");
      if (sectionHeader) sectionHeader.classList.remove("hidden");
      if (logPanel) logPanel.classList.remove("hidden");

      // 登录状态：显示可点击的蓝色超链接版本号
      const versionBadge = document.getElementById("footer-version-badge");
      if (versionBadge) {
        versionBadge.style.color = "var(--accent)";
        versionBadge.style.cursor = "pointer";
        versionBadge.style.textDecoration = "underline";
        versionBadge.title = "点击查看版本更新说明";
        versionBadge.onclick = openReleaseNotesModal;
      }

      initLogStream();
    } else {
      currentUser = null;
      if (authBtn) {
        authBtn.classList.remove("hidden");
        authBtn.innerText = "🔑 立即登录";
        authBtn.onclick = openAuthModal;
      }
      
      // 未登录时隐藏所有业务区、控制台与已登录菜单
      if (loggedActionsGroup) loggedActionsGroup.classList.add("hidden");
      if (statsGrid) statsGrid.classList.add("hidden");
      if (sectionHeader) sectionHeader.classList.add("hidden");
      if (logPanel) logPanel.classList.add("hidden");

      // 未登录状态：纯灰白普通文本，无下划线，不可点击
      const versionBadge = document.getElementById("footer-version-badge");
      if (versionBadge) {
        versionBadge.style.color = "var(--text-muted)";
        versionBadge.style.cursor = "default";
        versionBadge.style.textDecoration = "none";
        versionBadge.title = "";
        versionBadge.onclick = null;
      }
    }
  } catch (e) {
    if (!currentAuthToken) {
      if (authBtn) authBtn.classList.remove("hidden");
      if (loggedActionsGroup) loggedActionsGroup.classList.add("hidden");
      if (statsGrid) statsGrid.classList.add("hidden");
      if (sectionHeader) sectionHeader.classList.add("hidden");
      if (logPanel) logPanel.classList.add("hidden");
    }
  }
}

// Toast 提示 (带自动容错与自愈容器)
function showToast(message, type = "info") {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.className = "toast-container";
    document.body.appendChild(container);
  }
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
let cachedPointsDetails = [];

async function loadStatus() {
  try {
    const res = await authFetch("/api/status");
    const data = await res.json();
    document.getElementById("stat-total").innerText = data.accountsTotal || 0;
    document.getElementById("stat-online").innerText = data.onlineKeepAlive || 0;
    document.getElementById("stat-signed").innerText = data.signedToday || 0;
    document.getElementById("stat-points").innerText = data.totalEarnedPoints || 0;
    cachedPointsDetails = data.pointsDetails || [];
  } catch (e) {
    console.error("加载状态异常:", e);
  }
}

// 打开每日已获得积分详细明细模态框 (展示各任务具体达成时间节点)
function openPointsDetailModal() {
  const sumEl = document.getElementById("modal-points-sum");
  const listEl = document.getElementById("points-detail-list");
  const totalEarned = document.getElementById("stat-points").innerText || "0";
  sumEl.innerText = totalEarned;
  listEl.innerHTML = "";

  if (!cachedPointsDetails || cachedPointsDetails.length === 0) {
    listEl.innerHTML = `<div style="text-align:center; padding:24px; color:var(--text-muted); font-size:13px;">暂无云电脑今日积分明细</div>`;
    openModal("points-detail-modal");
    return;
  }

  cachedPointsDetails.forEach(acc => {
    const item = document.createElement("div");
    item.style.cssText = "background:var(--bg-surface); border:1px solid var(--border); border-radius:var(--radius); padding:16px; box-shadow:var(--shadow-sm);";

    let taskRows = (acc.tasks || []).map(t => {
      const isDone = t.completed || t.points > 0;
      return `
        <div style="display:flex; justify-content:space-between; align-items:center; font-size:12.5px; padding:8px 0; border-bottom:1px dashed #e2e8f0;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:14px;">${isDone ? '✅' : '⏳'}</span>
            <span style="font-weight:600; color:#0f172a;">${escapeHtml(t.name)}</span>
            <span style="font-size:11px; font-weight:700; color:${isDone ? '#16a34a' : '#64748b'}; background:${isDone ? '#f0fdf4' : '#f1f5f9'}; padding:2px 8px; border-radius:9999px; border:1px solid ${isDone ? '#bbf7d0' : '#e2e8f0'};">
              ${isDone ? `+${t.points} 积分` : `进行中 (${t.progress || '0/1'})`}
            </span>
          </div>
          <div style="display:flex; align-items:center; gap:6px; font-size:12px;">
            <span style="color:var(--text-muted);">达成时间节点:</span>
            <span style="font-family:monospace; font-weight:600; color:${isDone ? '#2563eb' : '#94a3b8'}; background:${isDone ? '#eff6ff' : '#f8fafc'}; padding:2px 8px; border-radius:4px; border:1px solid ${isDone ? '#dbeafe' : '#f1f5f9'};">
              ${isDone ? `🕒 ${escapeHtml(t.completedAt || '今日已达成')}` : '等待今日达成'}
            </span>
          </div>
        </div>
      `;
    }).join("");

    item.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; padding-bottom:8px; border-bottom:1px solid var(--border);">
        <span style="font-size:14px; font-weight:700; color:#0f172a;">🖥️ ${escapeHtml(acc.accountName)}</span>
        <span style="font-size:13px; color:#16a34a; font-weight:700;">今日获得: +${acc.todayPoints}分 (总积分: ${acc.totalPoints})</span>
      </div>
      <div style="display:flex; flex-direction:column; gap:2px;">
        ${taskRows}
      </div>
    `;
    listEl.appendChild(item);
  });

  openModal("points-detail-modal");
}

// 2. 加载多账号列表
let activeEditingAccId = null;

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

    let sessionBadge = '';
    if (acc.sessionExpired) {
      sessionBadge = `<span class="badge badge-danger" style="cursor:pointer;" onclick="editAccount('${acc.id}')">⚠️ 会话已失效，点击重新验证</span>`;
    }

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

    // 云电脑设备列表渲染 (支持单账号多台云电脑展示)
    let desktopsHtml = '';
    const dList = (acc.desktops && acc.desktops.length > 0) ? acc.desktops : [{
      desktopId: m.desktopId || acc.stats?.desktopId || '',
      desktopName: m.desktopName || '天翼云电脑',
      useStatusText: (acc.stats?.keepAliveStatus === 'online' || m.status === 'online') ? '运行中' : '就绪',
      flavorName: ''
    }];

    if (dList.length > 0) {
      desktopsHtml = `
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px;">
          <div style="font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 6px; display: flex; justify-content: space-between;">
            <span>🖥️ 名下云电脑 (${dList.length}台)</span>
            <span style="color: #64748b; font-weight: normal;">多设备独立支持</span>
          </div>
          <div style="display: flex; flex-direction: column; gap: 6px;">
            ${dList.map(d => `
              <div style="display: flex; justify-content: space-between; align-items: center; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 6px; padding: 6px 10px; font-size: 12px; gap: 8px;">
                <div style="display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; overflow: hidden;">
                  <span title="${escapeHtml(d.desktopName || '云电脑')}" style="color: #0f172a; font-weight: 600; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; flex-shrink: 1; cursor: help;">${escapeHtml(d.desktopName || '云电脑')}</span>
                  ${d.flavorName ? `<span style="font-size: 10.5px; background: #eff6ff; color: #2563eb; padding: 1px 6px; border-radius: 4px; flex-shrink: 0; white-space: nowrap;">${escapeHtml(d.flavorName)}</span>` : ''}
                </div>
                <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0; white-space: nowrap;">
                  <span style="color: ${(d.useStatusText || '').includes('运行') ? '#16a34a' : '#64748b'}; font-weight: 600; flex-shrink: 0; white-space: nowrap; font-size: 11.5px;">
                    ${(d.useStatusText || '').includes('运行') ? '🟢 ' : '⚪ '}${d.useStatusText || '运行中'}
                  </span>
                  <button class="btn btn-sm" style="padding: 2px 7px; font-size: 11px; flex-shrink: 0; white-space: nowrap;" onclick="openPowerModal('${acc.id}', '${d.desktopId}', '${escapeHtml(d.desktopName)}')">⚡ 电源</button>
                  <button class="btn btn-sm btn-primary" style="padding: 2px 7px; font-size: 11px; flex-shrink: 0; white-space: nowrap;" onclick="launchWebDesktop('${acc.id}', '${d.desktopId}')">🚀 打开</button>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    const displayName = acc.name || acc.user;
    const isEditingThis = (activeEditingAccId === acc.id);

    card.innerHTML = `
      <div class="card-top">
        <div class="account-main-info">
          <div class="account-avatar" id="acc-avatar-${acc.id}">${(displayName)[0].toUpperCase()}</div>
          <div class="account-name-block">
            <div class="account-name-row">
              <span class="account-name-text ${isEditingThis ? 'hidden' : ''}" id="acc-name-text-${acc.id}" onclick="startInlineEditName('${acc.id}')" title="点击直接修改账号备注">
                <span class="name-label" id="acc-name-val-${acc.id}">${escapeHtml(displayName)}</span>
                <span class="name-edit-icon" title="点击直接修改备注">✏️</span>
              </span>
              <input type="text" class="inline-name-input ${isEditingThis ? '' : 'hidden'}" id="acc-name-input-${acc.id}" value="${escapeHtml(displayName)}" onkeydown="handleInlineNameKey(event, '${acc.id}')" onblur="saveInlineName('${acc.id}')" maxlength="30" placeholder="账号备注名">
            </div>
            <div class="account-phone">
              📱 ${maskPhone} &nbsp; ${sessionBadge || boundBadge}
            </div>
          </div>
        </div>
        <div style="display: flex; gap: 4px;">
          <button class="btn btn-sm" onclick="editAccount('${acc.id}')" title="编辑账号与重新验证">✏️</button>
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

      <!-- 🖥️ 名下云电脑列表 (支持单账号多机器独立管理) -->
      ${desktopsHtml}

      <!-- 📡 真实 WebSocket 保活心跳状态监视 -->
      <div style="background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; font-size: 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <span style="color: #2563eb; font-weight: 700;">📡 状态与心跳监视</span>
          <span style="color: var(--text-muted);">周期: <b>${m.keepAliveSeconds || 60}s</b> (倒计时: <b style="color: #16a34a;">${m.cycleCountdown || 60}s</b>)</span>
        </div>
        <div style="color: #475569; line-height: 1.8;">
          <div style="display: flex; align-items: baseline; gap: 4px; overflow: hidden; white-space: nowrap;">
            <span style="flex-shrink: 0;">目标设备:</span>
            <span title="${escapeHtml(m.desktopName || '云电脑')} (${escapeHtml(m.currentHost || '未连接')})" style="color: #0f172a; font-weight: 600; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; flex: 1; cursor: help;">${escapeHtml(m.desktopName || '云电脑')} (${escapeHtml(m.currentHost || '未连接')})</span>
          </div>
          <div style="display: flex; align-items: baseline; gap: 4px; overflow: hidden; white-space: nowrap;">
            <span style="flex-shrink: 0;">当前动作:</span>
            <span title="${escapeHtml(m.lastHeartbeatResult || '正在建立心跳通道...')}" style="color: ${(m.lastHeartbeatResult || '').includes('避让') ? '#d97706' : '#16a34a'}; font-weight: 600; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; flex: 1; cursor: help;">${escapeHtml(m.lastHeartbeatResult || '正在建立心跳通道...')}</span>
          </div>
          <div>成功轮次: <span style="color: #2563eb; font-weight: 600;">${m.successCount || 0} 轮</span></div>
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
          <span>📡 启用云电脑保活 (${m.keepAliveSeconds || 60}s周期守护/${acc.pulseIntervalSeconds || 30}s旁观脉冲)</span>
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
        ${acc.sessionExpired ? `
          <button class="btn btn-danger btn-launch-full" onclick="editAccount('${acc.id}')" style="margin-bottom:6px;">
            <span>🔑 重新验证登录</span>
            <span class="btn-subtext">输验证码恢复 ➔</span>
          </button>
        ` : ''}
        <div class="card-action-tools">
          <button class="btn btn-tool" onclick="syncAccountTasks('${acc.id}')" title="一键极速执行今日全部任务 (打卡/AI对话/挂机)">🔄 一键同步任务</button>
          <button class="btn btn-tool" onclick="openPowerModal('${acc.id}')" title="云电脑电源管理 (开机/重启/关机)">⚡ 电源管理</button>
          <button class="btn btn-tool" onclick="openManualRedeemModal('${acc.id}')" title="根据当前积分手动兑换商品或抽奖">🎁 积分商城</button>
        </div>
        ${!acc.bound ? `<button class="btn btn-sm btn-warning" style="width:100%;margin-top:2px;" onclick="openSmsModal('${acc.id}')">📲 短信二次安全绑定</button>` : ''}
      </div>
    `;

    container.appendChild(card);
  });
}

// 账号备注名即点即改 (Inline Edit)
function startInlineEditName(accId) {
  activeEditingAccId = accId;
  const textEl = document.getElementById(`acc-name-text-${accId}`);
  const inputEl = document.getElementById(`acc-name-input-${accId}`);
  if (!textEl || !inputEl) return;
  textEl.classList.add("hidden");
  inputEl.classList.remove("hidden");
  inputEl.focus();
  inputEl.select();
}

function handleInlineNameKey(e, accId) {
  if (e.key === "Enter") {
    e.preventDefault();
    const inputEl = document.getElementById(`acc-name-input-${accId}`);
    if (inputEl) inputEl.blur();
  } else if (e.key === "Escape") {
    e.preventDefault();
    activeEditingAccId = null;
    const acc = accounts.find(a => a.id === accId);
    const textEl = document.getElementById(`acc-name-text-${accId}`);
    const inputEl = document.getElementById(`acc-name-input-${accId}`);
    if (inputEl && textEl) {
      inputEl.value = acc ? (acc.name || acc.user) : inputEl.value;
      inputEl.classList.add("hidden");
      textEl.classList.remove("hidden");
    }
  }
}

async function saveInlineName(accId) {
  const acc = accounts.find(a => a.id === accId);
  const textEl = document.getElementById(`acc-name-text-${accId}`);
  const inputEl = document.getElementById(`acc-name-input-${accId}`);
  const labelEl = document.getElementById(`acc-name-val-${accId}`);
  if (!acc || !inputEl || !textEl) {
    activeEditingAccId = null;
    return;
  }

  const newName = inputEl.value.trim();
  const oldName = acc.name || acc.user;
  activeEditingAccId = null;

  // 切回展示态
  inputEl.classList.add("hidden");
  textEl.classList.remove("hidden");

  // 如果内容没变或为空则还原
  if (!newName || newName === oldName) {
    inputEl.value = oldName;
    return;
  }

  // 响应式即时渲染 (Optimistic UI)
  const previousName = acc.name;
  acc.name = newName;
  if (labelEl) labelEl.textContent = newName;

  // 响应式更新头像字母
  const avatarEl = document.getElementById(`acc-avatar-${accId}`);
  if (avatarEl) avatarEl.textContent = (newName || acc.user)[0].toUpperCase();

  try {
    const res = await authFetch(`/api/accounts/${accId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName })
    });
    if (res.ok) {
      showToast(`账号备注已成功修改为 "${newName}"`, "success");
    } else {
      const err = await res.json();
      showToast("修改失败: " + (err.error || "未知错误"), "error");
      acc.name = previousName;
      if (labelEl) labelEl.textContent = previousName || acc.user;
      inputEl.value = previousName || acc.user;
      if (avatarEl) avatarEl.textContent = (previousName || acc.user)[0].toUpperCase();
    }
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
    acc.name = previousName;
    if (labelEl) labelEl.textContent = previousName || acc.user;
    inputEl.value = previousName || acc.user;
    if (avatarEl) avatarEl.textContent = (previousName || acc.user)[0].toUpperCase();
  }
}

// 快速切换开关
async function toggleFeature(accId, featureKey, checked) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  acc.features = acc.features || {};
  acc.features[featureKey] = checked;

  try {
    const res = await authFetch(`/api/accounts/${accId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ features: acc.features })
    });
    if (res.ok) {
      showToast(`已${checked ? '开启' : '关闭'}该功能`, "success");
    } else {
      showToast("更新失败", "error");
      // 更新失败则还原界面的复选状态
      acc.features[featureKey] = !checked;
      renderAccounts();
    }
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
    acc.features[featureKey] = !checked;
    renderAccounts();
  }
}

// 3. 添加/编辑账号
let currentCaptchaChallenge = null;

async function refreshModalCaptcha() {
  const user = document.getElementById("acc-user").value.trim() || '13800000000';
  const devCode = document.getElementById("acc-device-code").value.trim() || '';
  const imgEl = document.getElementById("acc-captcha-img");
  const loadingEl = document.getElementById("acc-captcha-loading");

  loadingEl.style.display = "inline";
  loadingEl.innerText = "获取中...";
  imgEl.style.display = "none";

  try {
    const res = await authFetch(`/api/captcha/${encodeURIComponent(user)}?deviceCode=${encodeURIComponent(devCode)}`);
    const data = await res.json();
    if (res.ok && data.success) {
      currentCaptchaChallenge = data;
      document.getElementById("acc-challenge-id").value = data.challengeId;
      document.getElementById("acc-challenge-code").value = data.challengeCode;
      imgEl.src = data.captchaImage;
      imgEl.style.display = "block";
      loadingEl.style.display = "none";
    } else {
      loadingEl.innerText = "获取失败，点击重试";
    }
  } catch (e) {
    loadingEl.innerText = "网络异常，点击重试";
  }
}

let qrPollingTimer = null;
let currentQrCodeId = '';

function switchAccountLoginTab(tab) {
  const btnQr = document.getElementById("tab-btn-qrcode");
  const btnPwd = document.getElementById("tab-btn-pwd");
  const panelQr = document.getElementById("login-panel-qrcode");
  const panelPwd = document.getElementById("login-panel-pwd");
  const btnSave = document.getElementById("btn-save-account-pwd");

  if (tab === 'qrcode') {
    if (btnQr) { btnQr.className = "btn btn-sm btn-primary"; }
    if (btnPwd) { btnPwd.className = "btn btn-sm"; }
    if (panelQr) panelQr.classList.remove("hidden");
    if (panelPwd) panelPwd.classList.add("hidden");
    if (btnSave) btnSave.style.display = "none";
    loadQrCodeForModal();
  } else {
    if (btnQr) { btnQr.className = "btn btn-sm"; }
    if (btnPwd) { btnPwd.className = "btn btn-sm btn-primary"; }
    if (panelQr) panelQr.classList.add("hidden");
    if (panelPwd) panelPwd.classList.remove("hidden");
    if (btnSave) btnSave.style.display = "inline-block";
    if (qrPollingTimer) { clearInterval(qrPollingTimer); qrPollingTimer = null; }
    setTimeout(refreshModalCaptcha, 200);
  }
}

async function loadQrCodeForModal() {
  if (qrPollingTimer) { clearInterval(qrPollingTimer); qrPollingTimer = null; }
  const imgEl = document.getElementById("acc-qrcode-img");
  const loadingEl = document.getElementById("acc-qrcode-loading");
  const hintEl = document.getElementById("acc-qrcode-hint");

  if (imgEl) imgEl.style.display = "none";
  if (loadingEl) { loadingEl.style.display = "flex"; loadingEl.innerText = "正在生成官方二维码..."; }
  if (hintEl) { hintEl.innerText = "等待扫码确认中..."; hintEl.style.color = "#2563eb"; }

  try {
    const res = await authFetch("/api/account/qrcode/generate", { method: "POST" });
    const data = await res.json();
    if (res.ok && data.success && data.qrUrl) {
      currentQrCodeId = data.qrCodeId;
      // 使用快速 QR 渲染引擎
      const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(data.qrUrl)}`;
      if (imgEl) {
        imgEl.src = qrApiUrl;
        imgEl.onload = () => {
          imgEl.style.display = "block";
          if (loadingEl) loadingEl.style.display = "none";
        };
      }

      // 启动 2 秒轮询看门狗 (携带用户填写的账号备注名，授权成功后直接以此命名)
      const nameVal = document.getElementById("qrcode-acc-name") ? document.getElementById("qrcode-acc-name").value.trim() : "";
      qrPollingTimer = setInterval(async () => {
        try {
          const sRes = await authFetch(`/api/account/qrcode/status?qrCodeId=${encodeURIComponent(currentQrCodeId)}&deviceCode=${encodeURIComponent(data.deviceCode)}&accountName=${encodeURIComponent(nameVal)}`);
          const sData = await sRes.json();
          if (sData.success) {
            if (sData.codeStatus === 'scaned') {
              if (hintEl) { hintEl.innerText = "📱 手机端已扫描，请在手机上点击【确认登录】..."; hintEl.style.color = "#16a34a"; }
            } else if (sData.codeStatus === 'authorize') {
              if (qrPollingTimer) { clearInterval(qrPollingTimer); qrPollingTimer = null; }
              showToast("🎉 官方扫码授权成功！云电脑已上线！", "success");
              closeModal("account-modal");
              loadAccounts();
            } else if (sData.codeStatus === 'expire') {
              if (qrPollingTimer) { clearInterval(qrPollingTimer); qrPollingTimer = null; }
              if (hintEl) { hintEl.innerText = "⚠️ 二维码已失效，点击刷新重试"; hintEl.style.color = "#ef4444"; }
              if (imgEl) imgEl.style.display = "none";
              if (loadingEl) {
                loadingEl.style.display = "flex";
                loadingEl.innerHTML = `<button class="btn btn-sm btn-primary" onclick="loadQrCodeForModal()">🔄 刷新二维码</button>`;
              }
            }
          }
        } catch (e) {}
      }, 2000);
    } else {
      if (loadingEl) loadingEl.innerText = "获取二维码失败: " + (data.error || '接口异常');
    }
  } catch (e) {
    if (loadingEl) loadingEl.innerText = "网络异常，点击重试";
  }
}

function openAddAccountModal() {
  document.getElementById("modal-account-title").innerText = "添加天翼云账号";
  document.getElementById("acc-id").value = "";
  document.getElementById("acc-name").value = "";
  document.getElementById("acc-user").value = "";
  document.getElementById("acc-password").value = "";
  document.getElementById("acc-captcha-code").value = "";
  document.getElementById("acc-device-code").value = "";
  const qrNameEl = document.getElementById("qrcode-acc-name");
  if (qrNameEl) qrNameEl.value = "";
  const tabContainer = document.getElementById("acc-login-tabs");
  if (tabContainer) tabContainer.style.display = "flex";
  openModal("account-modal");
  switchAccountLoginTab('qrcode');
}

function editAccount(accId) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  document.getElementById("modal-account-title").innerText = acc.sessionExpired ? "⚠️ 重新验证天翼云账号" : "编辑天翼云账号";
  document.getElementById("acc-id").value = acc.id;
  document.getElementById("acc-name").value = acc.name || "";
  document.getElementById("acc-user").value = acc.user || "";
  document.getElementById("acc-password").value = acc.password || "";
  document.getElementById("acc-captcha-code").value = "";
  document.getElementById("acc-device-code").value = acc.deviceCode || "";
  const tabContainer = document.getElementById("acc-login-tabs");
  if (tabContainer) tabContainer.style.display = "none";
  openModal("account-modal");
  switchAccountLoginTab('pwd');
  setTimeout(refreshModalCaptcha, 300);
}

async function generateNewDeviceCode() {
  try {
    const res = await authFetch("/api/device/generate", { method: "POST" });
    const data = await res.json();
    if (data && data.deviceCode) {
      document.getElementById("acc-device-code").value = data.deviceCode;
      showToast("已重新生成设备码", "info");
      refreshModalCaptcha();
    } else {
      // 前端本地生成 32 位标准 web_ 设备码作为即时兜底
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      let code = 'web_';
      for (let i = 0; i < 32; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
      document.getElementById("acc-device-code").value = code;
      showToast("已重新生成设备码", "info");
      refreshModalCaptcha();
    }
  } catch (e) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let code = 'web_';
    for (let i = 0; i < 32; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    document.getElementById("acc-device-code").value = code;
    showToast("已重新生成设备码", "info");
    refreshModalCaptcha();
  }
}

async function saveAccount() {
  const accId = document.getElementById("acc-id").value;
  const name = document.getElementById("acc-name").value.trim();
  const user = document.getElementById("acc-user").value.trim();
  const password = document.getElementById("acc-password").value.trim();
  const deviceCode = document.getElementById("acc-device-code").value.trim();
  const captchaCode = document.getElementById("acc-captcha-code").value.trim();
  const challengeId = document.getElementById("acc-challenge-id").value.trim();
  const challengeCode = document.getElementById("acc-challenge-code").value.trim();

  if (!user || !password) {
    showToast("手机号/账号与密码不能为空", "error");
    return;
  }

  // 新增账号或重登验证时，强制要求输入验证码
  if (!accId || (accId && captchaCode)) {
    if (!captchaCode) {
      showToast("请输入图形验证码", "error");
      document.getElementById("acc-captcha-code").focus();
      return;
    }
  }

  showToast("正在向天翼云发起真实登录验证，请稍候...", "info");

  const payload = {
    name: name || user,
    user,
    password,
    deviceCode,
    captchaCode,
    challengeId,
    challengeCode
  };

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
      showToast("❌ 操作未通过: " + (data.error || "验证码或密码错误"), "error");
      refreshModalCaptcha();
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

// ==========================================
// 手动积分兑换 / 幸运抽奖
// ==========================================
async function openManualRedeemModal(accId) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  document.getElementById("manual-acc-id").value = acc.id;
  document.getElementById("manual-acc-name").innerText = acc.name || acc.user;
  const pts = acc.liveMetrics?.userPoints || acc.stats?.points || 0;
  document.getElementById("manual-user-points").innerText = pts;
  document.getElementById("manual-order-times").value = 1;

  await loadManualProductList();
  await loadManualDesktops(accId);
  updateManualTotalCost();

  openModal("manual-redeem-modal");
}

async function loadManualProductList() {
  const select = document.getElementById("manual-prod-select");
  select.innerHTML = "<option value=''>加载天翼云商城最新商品...</option>";

  try {
    if (!availableRewards || availableRewards.length === 0) {
      const res = await authFetch("/api/rewards");
      availableRewards = await res.json();
    }

    select.innerHTML = "";
    availableRewards.forEach(r => {
      const opt = document.createElement("option");
      opt.value = r.prodId;
      opt.innerText = `${r.prodName} (${r.costPoints} 积分)`;
      opt.dataset.name = r.prodName;
      opt.dataset.points = r.costPoints;
      opt.dataset.type = r.prodType;
      opt.dataset.desc = r.description || "";
      select.appendChild(opt);
    });
    onManualProductChange();
  } catch (e) {
    select.innerHTML = "<option value='17023101' data-name='8C16G升配包1天' data-points='500' data-type='pointstplupgrade' data-desc='升级云电脑配置'>8C16G升配包1天 (500 积分)</option>";
    onManualProductChange();
  }
}

function onManualProductChange() {
  const select = document.getElementById("manual-prod-select");
  const selectedOpt = select.options[select.selectedIndex];
  if (selectedOpt) {
    document.getElementById("manual-prod-desc").innerText = selectedOpt.dataset.desc || "";
    // 如果是升配包（pointstplupgrade），需要选择云电脑；数据盘、智库等直发型商品无需强制选择设备
    const prodType = selectedOpt.dataset.type;
    const desktopGroup = document.getElementById("group-manual-desktop");
    if (desktopGroup) {
      desktopGroup.style.display = (prodType === 'pointstplupgrade') ? 'block' : 'none';
    }
  }
  updateManualTotalCost();
}

async function loadManualDesktops(accId) {
  const select = document.getElementById("manual-desktop-select");
  select.innerHTML = "<option value='0'>正在获取云电脑设备...</option>";

  try {
    const res = await authFetch(`/api/accounts/${accId}/desktops`);
    if (res.ok) {
      const list = await res.json();
      if (list.length > 0) {
        select.innerHTML = "";
        list.forEach(d => {
          const opt = document.createElement("option");
          opt.value = d.desktopId;
          opt.dataset.prodInstId = d.prodInstId || "";
          opt.innerText = `${d.desktopName || d.desktopCode} (${d.useStatusText || '运行中'})`;
          select.appendChild(opt);
        });
        return;
      }
    }
  } catch (e) {}

  select.innerHTML = "<option value='0'>主云电脑 (默认)</option>";
}

function updateManualTotalCost() {
  const select = document.getElementById("manual-prod-select");
  const selectedOpt = select.options[select.selectedIndex];
  const unitCost = selectedOpt ? (parseInt(selectedOpt.dataset.points) || 0) : 0;
  const times = Math.max(1, parseInt(document.getElementById("manual-order-times").value) || 1);
  const total = unitCost * times;
  document.getElementById("manual-cost-tip").innerText = `单价: ${unitCost}分 | 数量: ${times} | 预计消耗: ${total} 积分`;
}

async function submitManualRedeemOrder() {
  const accId = document.getElementById("manual-acc-id").value;
  const select = document.getElementById("manual-prod-select");
  const selectedOpt = select.options[select.selectedIndex];
  if (!selectedOpt) {
    showToast("请选择要兑换的商品", "error");
    return;
  }

  const prodId = parseInt(selectedOpt.value);
  const prodName = selectedOpt.dataset.name;
  const prodType = selectedOpt.dataset.type;
  const costPoints = parseInt(selectedOpt.dataset.points) || 0;
  const desktopSelect = document.getElementById("manual-desktop-select");
  const desktopId = parseInt(desktopSelect.value) || 0;
  const prodInstId = desktopSelect.options[desktopSelect.selectedIndex]?.dataset.prodInstId || "";
  const times = Math.max(1, parseInt(document.getElementById("manual-order-times").value) || 1);
  const totalCost = costPoints * times;

  const currentPts = parseInt(document.getElementById("manual-user-points").innerText) || 0;
  if (currentPts < totalCost) {
    showToast(`积分不足：当前拥有 ${currentPts} 分，本次兑换需要 ${totalCost} 分！`, "error");
    return;
  }

  if (!confirm(`确认消耗 ${totalCost} 积分立即兑换【${prodName} x${times}】吗？`)) {
    return;
  }

  const btn = document.getElementById("btn-manual-order-submit");
  btn.disabled = true;
  btn.innerText = "正在下单兑换...";

  try {
    const res = await authFetch(`/api/accounts/${accId}/order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prodId, prodName, prodType, costPoints, desktopId, times })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message || `🎉 成功兑换 ${prodName} x${times}！`, data.partial ? "warning" : "success");
      closeModal("manual-redeem-modal");
      await loadAccounts();
    } else {
      const errDetail = data.reason ? `${data.error}\n\n🔍 原因分析: ${data.reason}` : (data.error || "兑换下单失败");
      showToast(data.error || "兑换下单失败", "error");
      alert(errDetail);
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  } finally {
    // 防风控纪律：兑换后按钮强制 10 秒冷却，杜绝连续点击触发天翼云反欺诈
    let cooldown = 10;
    btn.innerText = `冷却中 (${cooldown}s)`;
    const timer = setInterval(() => {
      cooldown--;
      if (cooldown <= 0) {
        clearInterval(timer);
        btn.disabled = false;
        btn.innerText = "立即确认兑换";
      } else {
        btn.innerText = `冷却中 (${cooldown}s)`;
      }
    }, 1000);
  }
}

// ==========================================
// 云电脑电源管理 (开机 / 重启 / 关机)
// ==========================================
let currentPowerDesktopId = '';
let currentPowerAccountDesktops = [];

async function openPowerModal(accId, desktopId = '', desktopName = '') {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  document.getElementById("power-acc-id").value = acc.id;
  currentPowerDesktopId = desktopId || '';

  const select = document.getElementById("power-desktop-select");
  select.innerHTML = "<option value=''>正在获取名下云电脑...</option>";
  document.getElementById("power-desktop-status").innerHTML = `<span style="color: #64748b;">检测中...</span>`;
  openModal("power-modal");

  // 1. 先用本地已有的 desktops 缓存极速渲染
  const localList = (acc.desktops && acc.desktops.length > 0) ? acc.desktops : (acc.liveMetrics?.desktopName ? [{
    desktopId: acc.liveMetrics?.desktopId || acc.stats?.desktopId || '0',
    desktopName: acc.liveMetrics?.desktopName,
    useStatusText: '运行中',
    flavorName: ''
  }] : []);

  renderPowerDesktopSelect(localList, desktopId);

  // 2. 异步向后端拉取实时名下全部云电脑设备与状态
  try {
    const res = await authFetch(`/api/accounts/${accId}/desktops`);
    if (res.ok) {
      const list = await res.json();
      if (list && list.length > 0) {
        currentPowerAccountDesktops = list;
        renderPowerDesktopSelect(list, desktopId || currentPowerDesktopId);
      }
    }
  } catch (e) {}
}

function renderPowerDesktopSelect(list, targetDesktopId) {
  const select = document.getElementById("power-desktop-select");
  if (!select) return;
  if (!list || list.length === 0) {
    select.innerHTML = "<option value=''>默认主云电脑</option>";
    onPowerDesktopChange();
    return;
  }

  currentPowerAccountDesktops = list;
  select.innerHTML = "";
  list.forEach((d, idx) => {
    const opt = document.createElement("option");
    opt.value = d.desktopId;
    opt.dataset.status = d.useStatusText || '运行中';
    const flavor = d.flavorName ? ` [${d.flavorName}]` : '';
    opt.innerText = `🖥️ ${d.desktopName || '云电脑'}${flavor} - (${d.useStatusText || '运行中'})`;
    
    // 如果指定了 targetDesktopId，或者首项匹配
    if (targetDesktopId && String(targetDesktopId) === String(d.desktopId)) {
      opt.selected = true;
    } else if (!targetDesktopId && idx === 0) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });

  onPowerDesktopChange();
}

function onPowerDesktopChange() {
  const select = document.getElementById("power-desktop-select");
  const statusEl = document.getElementById("power-desktop-status");
  if (!select || !statusEl) return;

  currentPowerDesktopId = select.value || '';
  const selectedOpt = select.options[select.selectedIndex];
  if (selectedOpt && selectedOpt.dataset.status) {
    const st = selectedOpt.dataset.status;
    const isRunning = st.includes('运行');
    statusEl.innerHTML = `<span style="color: ${isRunning ? '#16a34a' : '#d97706'}; font-weight:700;">${isRunning ? '🟢 ' : '⚪ '}${st}</span>`;
  } else {
    statusEl.innerHTML = `<span style="color: #64748b;">就绪</span>`;
  }
}

async function executePowerAction(action) {
  const accId = document.getElementById("power-acc-id").value;
  const actionNames = { poweron: '开机', reboot: '重启', shutdown: '关机' };
  const actionName = actionNames[action] || action;

  if (action === 'shutdown' || action === 'reboot') {
    if (!confirm(`确认要对云电脑下达【${actionName}】指令吗？未保存的数据可能会丢失。`)) {
      return;
    }
  }

  showToast(`正在向天翼云下发【${actionName}】指令...`, "info");
  try {
    const query = currentPowerDesktopId ? `?desktopId=${encodeURIComponent(currentPowerDesktopId)}` : '';
    const res = await authFetch(`/api/accounts/${accId}/power/${action}${query}`, { method: "POST" });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message || `【${actionName}】指令下达成功！`, "success");
      closeModal("power-modal");
      // 立即刷新前端账号开关状态并重载列表
      await loadAccounts(true);
      setTimeout(() => loadAccounts(true), 1500);
    } else {
      showToast(data.error || `操作失败: ${data.message || '网关拒绝'}`, "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

// ==========================================
// 弹窗浏览器免密直达访问云电脑 (自动匹配设定的分辨率与缩放)
// ==========================================
async function launchWebDesktop(accId, targetDesktopId = '') {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;

  showToast(`正在获取 [${acc.name || acc.user}] 的云电脑直达访问会话...`, "info");

  try {
    const query = targetDesktopId ? `?desktopId=${encodeURIComponent(targetDesktopId)}` : '';
    const res = await authFetch(`/api/accounts/${accId}/web-launch${query}`);
    const data = await res.json();
    if (!res.ok || !data.success) {
      showToast(data.error || "获取访问会话失败", "error");
      return;
    }

    const winWidth = Math.min(window.screen.availWidth || 1920, 1920);
    const winHeight = Math.min(window.screen.availHeight || 1080, 1080);
    const left = Math.max(0, Math.round((window.screen.availWidth - winWidth) / 2));
    const top = Math.max(0, Math.round((window.screen.availHeight - winHeight) / 2));

    const windowFeatures = `width=${winWidth},height=${winHeight},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes`;
    
    // 构造直通操作界面 URL (自动免密注入与云电脑操作界面自适应)
    const token = currentAuthToken || localStorage.getItem('ctyun_auth_token') || '';
    const directViewParam = targetDesktopId ? `&desktopId=${encodeURIComponent(targetDesktopId)}` : '';
    const launchUrl = data.directViewUrl || `/desktop-view?accId=${accId}&token=${encodeURIComponent(token)}${directViewParam}`;

    // 打开免密直通独立操作窗口
    const popup = window.open(launchUrl, `ctyun_desktop_${accId}_${targetDesktopId || 'main'}`, windowFeatures);

    if (popup) {
      popup.focus();
      showToast(`已为您直达打开【${data.desktopName}】云电脑操作界面！已自动完成免密鉴权。`, "success");
    } else {
      showToast("弹窗被浏览器拦截，请在地址栏右侧允许本站点弹出窗口！", "warning");
      window.open(launchUrl, '_blank');
    }
  } catch (e) {
    showToast("访问请求异常: " + e.message, "error");
  }
}

// 6. 手动触发任务与一键全量任务同步
async function syncAccountTasks(accId) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;

  const f = acc.features || {};
  showToast(`正在为【${acc.name || acc.user}】执行已开启项任务即时同步...`, "info");
  
  const tasksToRun = [];
  if (f.autoSign !== false) tasksToRun.push({ type: 'sign', name: '登录打卡' });
  if (f.aiChat !== false) tasksToRun.push({ type: 'aiChat', name: 'AI对话' });
  if (f.cloudHang !== false) tasksToRun.push({ type: 'hang', name: '挂机守护' });
  if (f.autoRedeem) tasksToRun.push({ type: 'redeem', name: '兑换检查' });

  if (tasksToRun.length === 0) {
    showToast(`【${acc.name || acc.user}】未开启任何自动化任务选项，无需同步。`, "warning");
    return;
  }

  try {
    for (const t of tasksToRun) {
      await authFetch(`/api/accounts/${accId}/run/${t.type}`, { method: "POST" });
    }

    showToast(`🎉【${acc.name || acc.user}】已开启任务（${tasksToRun.map(t=>t.name).join('/')}）已即时完成同步！`, "success");
    setTimeout(() => loadAccounts(true), 1200);
  } catch (e) {
    showToast("任务同步异常: " + e.message, "error");
  }
}

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
    if (document.getElementById("set-system-title")) {
      document.getElementById("set-system-title").value = settings.systemTitle || "天翼云自动化控制中心";
    }
    if (document.getElementById("cron-task-time")) {
      document.getElementById("cron-task-time").value = c.executeTime || "01:20";
    }
    const enableSub = c.enableSubCron === true;
    if (document.getElementById("cron-enable-sub")) {
      document.getElementById("cron-enable-sub").checked = enableSub;
    }
    document.getElementById("cron-sign").value = c.signCron || "";
    document.getElementById("cron-aichat").value = c.aiChatCron || "";
    document.getElementById("cron-hang").value = c.cloudHangCron || "";
    document.getElementById("cron-redeem").value = c.redeemCron || "";
    toggleSubCronInputs(enableSub);

    document.getElementById("set-keepalive-sec").value = settings.keepAliveSeconds || 60;
    if (document.getElementById("set-pulse-sec")) {
      document.getElementById("set-pulse-sec").value = settings.pulseIntervalSeconds || (settings.pulseIntervalMinutes ? settings.pulseIntervalMinutes * 60 : 30);
    }
    if (document.getElementById("set-allow-reg")) {
      document.getElementById("set-allow-reg").checked = settings.allowRegistration === true;
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

function toggleSubCronInputs(enabled) {
  const container = document.getElementById("sub-cron-inputs-container");
  if (!container) return;
  const inputs = container.querySelectorAll("input");
  inputs.forEach(input => {
    input.disabled = !enabled;
    input.style.opacity = enabled ? "1" : "0.55";
    input.style.background = enabled ? "#ffffff" : "#f1f5f9";
  });
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
  const customTitle = document.getElementById("set-system-title") ? document.getElementById("set-system-title").value.trim() : "";
  const payload = {
    systemTitle: customTitle || "天翼云自动化控制中心",
    keepAliveSeconds: parseInt(document.getElementById("set-keepalive-sec").value) || 60,
    pulseIntervalSeconds: Math.min(3300, Math.max(10, parseInt(document.getElementById("set-pulse-sec") ? document.getElementById("set-pulse-sec").value : 30) || 30)),
    allowRegistration: document.getElementById("set-allow-reg") ? document.getElementById("set-allow-reg").checked : true,
    defaultQuota: document.getElementById("set-default-quota") ? parseInt(document.getElementById("set-default-quota").value) || 2 : 2,
    cron: {
      executeTime: document.getElementById("cron-task-time") ? document.getElementById("cron-task-time").value.trim() : "08:00",
      enableSubCron: document.getElementById("cron-enable-sub") ? document.getElementById("cron-enable-sub").checked : false,
      signCron: document.getElementById("cron-sign") ? document.getElementById("cron-sign").value.trim() : "",
      aiChatCron: document.getElementById("cron-aichat") ? document.getElementById("cron-aichat").value.trim() : "",
      cloudHangCron: document.getElementById("cron-hang") ? document.getElementById("cron-hang").value.trim() : "",
      redeemCron: document.getElementById("cron-redeem") ? document.getElementById("cron-redeem").value.trim() : ""
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
      if (payload.systemTitle) {
        const titleEl = document.getElementById("main-system-title");
        if (titleEl) titleEl.innerText = payload.systemTitle;
        document.title = `${payload.systemTitle} - 多账号保活控制台`;
      }
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
    logBox.innerHTML = `<div class="log-line" style="color: #64748b; padding: 12px 0; text-align: center;">[暂无此类日志]</div>`;
    return;
  }

  filtered.forEach(item => {
    const line = document.createElement("div");
    line.className = `log-line log-level-${item.level || 'info'}`;
    if (item.id) line.dataset.logId = item.id;
    const repeatBadge = (item.repeatCount && item.repeatCount > 1) 
      ? `<span class="badge-repeat">x${item.repeatCount}</span>` 
      : '';
    line.innerHTML = `
      <span class="log-time">[${item.timestamp}]</span>
      <span class="log-source">[${item.source}]</span>
      <span class="log-text">${escapeHtml(item.message)}</span>${repeatBadge}
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
    statusSpan.className = "badge badge-offline";
    return;
  }

  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  // 仅通过单一的 SSE 流实时推送与初始化历史日志，彻底消除“历史请求+初始流”造成的二次重复！
  const sseUrl = `/api/logs/stream?token=${encodeURIComponent(currentAuthToken)}`;
  eventSource = new EventSource(sseUrl);

  eventSource.onopen = () => {
    statusSpan.innerText = "已连接";
    statusSpan.className = "badge badge-online";
  };

  eventSource.onmessage = (e) => {
    try {
      const item = JSON.parse(e.data);

      if (item.isUpdate) {
        // 全双工智能折叠：就地更新最后一行，刷新时间戳与徽标 x99
        const idx = allReceivedLogs.findIndex(l => (l.id && l.id === item.id) || (l.source === item.source && l.accountName === item.accountName));
        if (idx !== -1) {
          allReceivedLogs[idx] = item;
        } else {
          allReceivedLogs.push(item);
        }

        const logBox = document.getElementById("log-content");
        const existingLine = item.id ? logBox.querySelector(`[data-log-id="${item.id}"]`) : null;
        if (existingLine) {
          const repeatBadge = item.repeatCount > 1 ? `<span class="badge-repeat">x${item.repeatCount}</span>` : '';
          existingLine.innerHTML = `
            <span class="log-time">[${item.timestamp}]</span>
            <span class="log-source">[${item.source}]</span>
            <span class="log-text">${escapeHtml(item.message)}</span>${repeatBadge}
          `;
          existingLine.classList.remove('log-flash');
          void existingLine.offsetWidth;
          existingLine.classList.add('log-flash');
          if (autoScroll) logBox.scrollTop = logBox.scrollHeight;
          return;
        }
      }

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
        if (item.id) line.dataset.logId = item.id;
        const repeatBadge = (item.repeatCount && item.repeatCount > 1) 
          ? `<span class="badge-repeat">x${item.repeatCount}</span>` 
          : '';
        line.innerHTML = `
          <span class="log-time">[${item.timestamp}]</span>
          <span class="log-source">[${item.source}]</span>
          <span class="log-text">${escapeHtml(item.message)}</span>${repeatBadge}
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

async function clearLogs() {
  allReceivedLogs = [];
  document.getElementById("log-content").innerHTML = `<div class="log-line" style="color: #64748b; padding: 12px 0; text-align: center;">[日志已彻底清空]</div>`;
  
  // 联动后端持久化清空
  try {
    const res = await authFetch('/api/logs/clear', { method: 'POST' });
    if (res.ok) {
      showToast("控制台与后台历史日志已全部一键清空", "success");
    } else {
      showToast("前端已清屏", "info");
    }
  } catch (e) {
    showToast("前端已清屏", "info");
  }
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
function openReleaseNotesModal() {
  if (!currentUser && !currentAuthToken) {
    showToast("请先登录账号后再查看版本更新介绍！", "warning");
    openAuthModal();
    return;
  }
  openModal("release-notes-modal");
}

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
  setTimeout(() => {
    const input = document.getElementById("auth-username");
    if (input) input.focus();
  }, 100);
}

function switchAuthMode(mode) {
  authMode = mode;
  const isLogin = mode === "login";
  document.getElementById("auth-modal-title").innerText = isLogin ? "用户登录" : "新用户注册";
  document.getElementById("btn-auth-tab-login").className = isLogin ? "btn btn-sm btn-primary" : "btn btn-sm";
  document.getElementById("btn-auth-tab-reg").className = !isLogin ? "btn btn-sm btn-primary" : "btn btn-sm";
  document.getElementById("btn-auth-submit").innerText = isLogin ? "立即登录" : "立即注册并登录";
  const tipEle = document.getElementById("auth-tip");
  if (tipEle) {
    tipEle.innerHTML = "";
  }
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
      // 立即前端就地置为已登录，彻底消除任何 DOM 刷新等待延迟！
      currentUser = data.user;
      const isAdmin = currentUser.role === "admin";
      const initial = (currentUser.username || "A")[0].toUpperCase();
      const headerAvatar = document.getElementById("header-avatar");
      const dropdownUsername = document.getElementById("dropdown-username");
      const menuAdminUsers = document.getElementById("menu-admin-users");
      const authBtn = document.getElementById("btn-auth-action");
      const loggedActionsGroup = document.getElementById("logged-actions-group");
      const statsGrid = document.getElementById("main-stats-grid");
      const sectionHeader = document.getElementById("main-section-header");
      const logPanel = document.getElementById("main-log-panel");

      if (headerAvatar) headerAvatar.innerText = initial;
      if (dropdownUsername) dropdownUsername.innerText = `${currentUser.username} (${isAdmin ? '管理员' : '普通用户'})`;
      if (menuAdminUsers) menuAdminUsers.classList.toggle("hidden", !isAdmin);
      if (authBtn) authBtn.classList.add("hidden");
      if (loggedActionsGroup) loggedActionsGroup.classList.remove("hidden");
      if (statsGrid) statsGrid.classList.remove("hidden");
      if (sectionHeader) sectionHeader.classList.remove("hidden");
      if (logPanel) logPanel.classList.remove("hidden");

      const versionBadge = document.getElementById("footer-version-badge");
      if (versionBadge) {
        versionBadge.style.color = "var(--accent)";
        versionBadge.style.cursor = "pointer";
        versionBadge.style.textDecoration = "underline";
        versionBadge.title = "点击查看版本更新说明";
        versionBadge.onclick = openReleaseNotesModal;
      }

      checkCurrentUser();
      loadAccounts();
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
  if (eventSource) {
    try { eventSource.close(); } catch (e) {}
    eventSource = null;
  }
  allReceivedLogs = [];
  const logBox = document.getElementById("log-content");
  if (logBox) logBox.innerHTML = '<div class="log-line"><span class="log-time">[系统]</span> 未登录状态，日志已隐藏</div>';
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

// 修改个人密码/修改管理员用户名
function openChangePwdModal() {
  document.getElementById("new-user-pwd").value = "";
  document.getElementById("confirm-user-pwd").value = "";
  const adminGroup = document.getElementById("admin-change-username-group");
  if (adminGroup) {
    const isAdmin = currentUser && currentUser.role === "admin";
    adminGroup.classList.toggle("hidden", !isAdmin);
    if (isAdmin) {
      document.getElementById("new-admin-username").value = currentUser.username || "admin";
    }
  }
  openModal("change-pwd-modal");
}

async function submitChangeUsername() {
  const newName = document.getElementById("new-admin-username").value.trim();
  if (!newName) {
    showToast("用户名不能为空", "error");
    return;
  }

  try {
    const res = await authFetch("/api/auth/change-username", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newUsername: newName })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`管理员用户名已成功修改为: ${newName}！`, "success");
      await checkCurrentUser();
    } else {
      showToast(data.error || "修改失败", "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
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

