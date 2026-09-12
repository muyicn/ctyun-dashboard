// 全局状态
let accounts = [];
let availableRewards = [];
let autoScroll = true;
let eventSource = null;
let currentUser = null;
let currentAuthToken = localStorage.getItem("ctyun_auth_token") || "";
let allReceivedLogs = [];
let activeLogFilter = 'tasks';
let activePlatformFilter = 'all'; // 'all' | 'ctyun' | 'ydpc'
let activeAccountViewTab = 'all'; // 'all' | 'ctyun' | 'ydpc'
let currentAddPlatform = 'ctyun';  // 'ctyun' | 'ydpc'
let authMode = "login";
let cachedPointsDetails = [];
let activeEditingAccId = null;
let currentCaptchaChallenge = null;
let qrPollingTimer = null;
let currentQrCodeId = '';
let smsCountdown = 0;
let currentPowerDesktopId = '';
let currentPowerAccountDesktops = [];

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

    // 动态同步主标题与副标题名称
    if (data.systemTitle) {
      const titleEl = document.getElementById("main-system-title");
      if (titleEl) titleEl.innerText = data.systemTitle;
      document.title = `${data.systemTitle} - 多账号保活控制台`;
    }
    if (data.systemSubtitle) {
      const subtitleEl = document.querySelector(".title-group p");
      if (subtitleEl) subtitleEl.innerText = data.systemSubtitle;
    }

    if (data.isLoggedIn && data.user) {
      currentUser = data.user;
      const isAdmin = currentUser.role === "admin";
      
      // 更新头像首字母/个性化头像和下拉菜单用户名
      const avatarText = currentUser.avatar || (currentUser.username || "A")[0].toUpperCase();
      if (headerAvatar) headerAvatar.innerText = avatarText;
      if (dropdownUsername) dropdownUsername.innerText = `${currentUser.username} (${isAdmin ? '管理员' : '普通用户'})`;
      if (menuAdminUsers) menuAdminUsers.classList.toggle("hidden", !isAdmin);

      const menuChangePwd = document.getElementById("menu-change-pwd");
      if (menuChangePwd) {
        menuChangePwd.innerText = isAdmin ? "🔒 修改密码/用户名" : "🔒 修改密码";
      }

      const settingsDropdown = document.getElementById("settings-dropdown-container");
      if (settingsDropdown) settingsDropdown.classList.toggle("hidden", !isAdmin);

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
  toast.style.whiteSpace = "pre-line"; // 支持换行多排显示
  toast.innerText = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 4500);
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

function switchAccountViewTab(tab) {
  activeAccountViewTab = tab;
  const tabAll = document.getElementById("view-tab-all");
  const tabCt = document.getElementById("view-tab-ctyun");
  const tabYd = document.getElementById("view-tab-ydpc");
  if (tabAll) tabAll.className = tab === 'all' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  if (tabCt) tabCt.className = tab === 'ctyun' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  if (tabYd) tabYd.className = tab === 'ydpc' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  renderAccounts();
}

// 记录每个卡片各折叠面板的展开/收起状态 (持久化到 localStorage)
function getDetailsStateKey(accId, panelKey) {
  return `ctyun_details_${accId}_${panelKey}`;
}

function isDetailsOpen(accId, panelKey, defaultOpen = true) {
  const saved = localStorage.getItem(getDetailsStateKey(accId, panelKey));
  if (saved === null) return defaultOpen;
  return saved === 'true';
}

function saveDetailsState(accId, panelKey, isOpen) {
  localStorage.setItem(getDetailsStateKey(accId, panelKey), String(isOpen));
}

// 获取当前网格的响应式列数
function getGridColumns() {
  const container = document.getElementById("accounts-container");
  if (!container) return 3;
  const style = window.getComputedStyle(container);
  const gridTemplateColumns = style.gridTemplateColumns;
  if (!gridTemplateColumns || gridTemplateColumns === "none") return 3;
  const cols = gridTemplateColumns.split(/\s+/).filter(Boolean).length;
  return Math.max(1, cols);
}

// 缓存当前用户的网格插槽布局状态: array of (accId | null)
function getGridSlotsKey() {
  const uid = currentUser?.userId || 'u_admin';
  return `ctyun_grid_slots_${uid}_${activeAccountViewTab}`;
}

function getFilteredAccounts() {
  const hasCtyun = (accounts || []).some(a => a.platform === 'ctyun' || !a.platform);
  const hasYdpc = (accounts || []).some(a => a.platform === 'ydpc');
  return (accounts || []).filter(acc => {
    if (!hasCtyun || !hasYdpc) return true; // 单一平台不过滤
    if (activeAccountViewTab === 'all') return true;
    if (activeAccountViewTab === 'ctyun') return acc.platform === 'ctyun' || !acc.platform;
    if (activeAccountViewTab === 'ydpc') return acc.platform === 'ydpc';
    return true;
  });
}

function loadGridSlots(filteredAccs, cols) {
  const key = getGridSlotsKey();
  let savedSlots = null;
  try {
    const raw = localStorage.getItem(key);
    if (raw) savedSlots = JSON.parse(raw);
  } catch (e) {}

  const currentIds = new Set(filteredAccs.map(a => a.id));
  let slots = Array.isArray(savedSlots) ? [...savedSlots] : [];

  // 清理不存在于当前过滤列表的无效 ID
  for (let i = 0; i < slots.length; i++) {
    if (slots[i] && !currentIds.has(slots[i])) {
      slots[i] = null;
    }
  }

  // 确保所有当前账号都已映射到插槽
  const placedIds = new Set(slots.filter(Boolean));
  for (const acc of filteredAccs) {
    if (!placedIds.has(acc.id)) {
      const emptyIdx = slots.indexOf(null);
      if (emptyIdx !== -1) {
        slots[emptyIdx] = acc.id;
      } else {
        slots.push(acc.id);
      }
      placedIds.add(acc.id);
    }
  }

  // 计算最后一个实际有卡片占用的插槽索引
  let lastOccupied = -1;
  for (let i = slots.length - 1; i >= 0; i--) {
    if (slots[i] && currentIds.has(slots[i])) {
      lastOccupied = i;
      break;
    }
  }

  // 约束总行数：以最高占用行与最少必要行对齐，杜绝末尾凭空多出空行
  const minRows = Math.ceil(filteredAccs.length / cols);
  const occupiedRows = lastOccupied >= 0 ? Math.ceil((lastOccupied + 1) / cols) : 0;
  const totalRows = Math.max(minRows, occupiedRows, 1);
  const totalSlots = totalRows * cols;

  if (slots.length > totalSlots) {
    slots = slots.slice(0, totalSlots);
  }
  while (slots.length < totalSlots) {
    slots.push(null);
  }

  return slots;
}

function saveGridSlots(slots) {
  const key = getGridSlotsKey();
  try {
    localStorage.setItem(key, JSON.stringify(slots));
  } catch (e) {}
}

function buildOfficialTasksHtml(m) {
  if (m.officialTasks && m.officialTasks.length > 0) {
    return m.officialTasks.map(t => {
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
  }
  return `<div style="font-size: 12px; color: var(--text-muted); text-align: center; padding: 6px 0;">正在同步天翼云官方任务中心数据...</div>`;
}

// 构造单个账号卡片 DOM 节点
function buildAccountCardElement(acc, slotIndex) {
  const card = document.createElement("div");
  card.className = "account-card";
  card.id = `acc-card-${acc.id}`;
  card.dataset.accId = acc.id;
  card.dataset.slot = slotIndex;
  card.draggable = true;

  // 绑定 HTML5 原生无损拖拽事件
  card.addEventListener("dragstart", handleCardDragStart);
  card.addEventListener("dragover", handleCardDragOver);
  card.addEventListener("dragleave", handleCardDragLeave);
  card.addEventListener("drop", handleCardDrop);
  card.addEventListener("dragend", handleCardDragEnd);

  const isYdpc = acc.platform === 'ydpc';
  const isYdpcRealOnline = isYdpc ? (acc.liveMetrics?.status === "online") : (acc.stats?.keepAliveStatus === "online" || acc.liveMetrics?.status === "online");
  const statusBadge = isYdpcRealOnline
    ? `<span class="badge badge-online">保活在线</span>`
    : `<span class="badge badge-offline">离线待机</span>`;

  const fullPhone = escapeHtml(acc.user);
  const displayName = acc.name || acc.user;
  const isEditingThis = (activeEditingAccId === acc.id);
  const f = acc.features || {};
  const m = acc.liveMetrics || {};

  if (isYdpc) {
    // ====================================================
    // 📱 移动云电脑专属卡片呈现
    // ====================================================
    const typeBadge = acc.accountType === 'sub'
      ? `<span class="badge" style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;">独立子账号</span>`
      : `<span class="badge" style="background:#fef3c7;color:#b45309;border:1px solid #fde68a;">和家亲主账号</span>`;

    const vms = acc.vms || m.vms || [];
    const vmsCountText = vms.length > 0 ? `名下云主机 (${vms.length}台)` : '云主机';

    let vmsHtml = '';
    if (vms.length > 0) {
      vmsHtml = `
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px;">
          <div style="font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 6px; display: flex; justify-content: space-between;">
            <span>🖥️ ${vmsCountText}</span>
            <span style="color: #64748b; font-weight: normal;">自动识别限时/永久</span>
          </div>
          <div style="display: flex; flex-direction: column; gap: 6px;">
            ${vms.map(vm => {
              const statusStr = String(vm.vmStatus || vm.vmStatusShow || '');
              const isRunning = statusStr.includes('运行') || vm.vmStatus === 1 || vm.vmStatusCode === 1;
              const cpuClean = vm.cpu ? String(vm.cpu).replace(/核+$/g, '') : '';
              const memClean = vm.memory ? String(vm.memory).replace(/[Gg]+$/g, '') : '';
              const specSuffix = (cpuClean && memClean) ? ` · ${cpuClean}核/${memClean}G` : (cpuClean ? ` · ${cpuClean}核` : (memClean ? ` · ${memClean}G` : ''));
              return `
                <div style="display: flex; justify-content: space-between; align-items: center; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 6px; padding: 7px 10px; font-size: 12px; gap: 8px;">
                  <div style="display: flex; flex-direction: column; min-width: 0; flex: 1;">
                    <span style="color: #0f172a; font-weight: 700; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${escapeHtml(vm.vmName || '移动云电脑')}</span>
                    <span style="font-size: 11px; color: #64748b;">USID: ${vm.userServiceId}${specSuffix}</span>
                  </div>
                  <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
                    <span class="badge ${isRunning ? 'badge-online' : 'badge-offline'}">${isRunning ? '运行中' : '已关机'}</span>
                    <span style="font-size: 11.5px; font-weight: 600; color: ${vm.durationMode === 'limited' ? '#b45309' : '#059669'};">${vm.remainText || '♾️ 永久'}</span>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    } else {
      vmsHtml = `<div style="font-size: 12px; color: var(--text-muted); text-align: center; padding: 8px; background:#f8fafc; border-radius:6px; border:1px solid #e2e8f0;">暂未拉取到名下云主机，点击下方心跳或握手自动同步</div>`;
    }

    const primaryUsid = vms[0]?.userServiceId || '';

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
              <input type="text" class="inline-name-input ${isEditingThis ? '' : 'hidden'}" id="acc-name-input-${acc.id}" value="${escapeHtml(displayName)}" onkeydown="handleInlineNameKey(event, '${acc.id}')" onblur="saveInlineName('${acc.id}')" maxlength="30">
            </div>
            <div class="account-phone">
              <span>${fullPhone}</span>
              <span class="badge" style="background:#e0f2fe;color:#0369a1;border:1px solid #bae6fd;">移动云</span>
              ${typeBadge}
            </div>
          </div>
        </div>
        <div style="display: flex; gap: 4px;">
          <button class="btn btn-sm" onclick="editAccount('${acc.id}')" title="编辑移动云账号">✏️</button>
          <button class="btn btn-sm btn-danger" onclick="deleteAccount('${acc.id}')" title="删除账号">🗑️</button>
        </div>
      </div>

      <!-- 🖥️ 名下云主机列表 -->
      ${vmsHtml}

      <!-- 📡 移动云专属 CAG 握手与心跳监视 -->
      <div style="background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; font-size: 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <span style="color: #0369a1; font-weight: 700;">📡 移动云 ZTEC 握手与心跳监视</span>
          <span id="acc-status-badge-${acc.id}">${statusBadge}</span>
        </div>
        <div style="color: #475569; line-height: 1.8;">
          <div style="display: flex; align-items: baseline; gap: 4px; overflow: hidden; white-space: nowrap;">
            <span style="flex-shrink: 0;">当前动作:</span>
            <span id="acc-hb-text-${acc.id}" title="${escapeHtml(m.lastHeartbeatResult || '保活巡检待命')}" style="color: #0284c7; font-weight: 600; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; flex: 1; cursor: help;">${escapeHtml(m.lastHeartbeatResult || '保活巡检待命')}</span>
          </div>
          <div id="acc-active-info-${acc.id}">上次活跃: <span style="color: #0f172a; font-weight: 600;">${m.lastHeartbeatTime || acc.stats?.lastKeepAliveTime || '刚刚'}</span> · 周期: <b>${Math.round((acc.keepaliveInterval || 600) / 60)} 分钟</b></div>
        </div>
      </div>

      <!-- 专属功能开关 (精致折叠设计，状态持久化) -->
      <details class="features-box" style="padding: 10px 14px;" ${isDetailsOpen(acc.id, 'features') ? 'open' : ''} ontoggle="saveDetailsState('${acc.id}', 'features', this.open)">
        <summary style="display: flex; justify-content: space-between; align-items: center; cursor: pointer; font-size: 12.5px; font-weight: 700; color: #334155; user-select: none; margin-bottom: 2px;">
          <span>⚙️ 自动化保活开关</span>
          <span style="font-size: 11px; color: var(--text-muted); font-weight: normal;">点击收起/展开</span>
        </summary>
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
          <div class="feature-row">
            <span>🛡️ 自动开机守护 (检测到关机自动唤醒)</span>
            <label class="switch">
              <input type="checkbox" ${f.autoBoot !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'autoBoot', this.checked)">
              <span class="slider"></span>
            </label>
          </div>
          <div class="feature-row">
            <span>🔄 ZTEC CAG TCP 三阶段握手保活</span>
            <label class="switch">
              <input type="checkbox" ${f.cagKeepAlive !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'cagKeepAlive', this.checked)">
              <span class="slider"></span>
            </label>
          </div>
          <div class="feature-row">
            <span>💓 SOHO REST 定期心跳保持</span>
            <label class="switch">
              <input type="checkbox" ${f.sohoHeartbeat !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'sohoHeartbeat', this.checked)">
              <span class="slider"></span>
            </label>
          </div>
        </div>
      </details>

      <!-- 快捷操作区 -->
      <div class="card-actions">
        <div class="card-action-tools" style="grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));">
          <button class="btn btn-tool" onclick="bootYdpcVm('${acc.id}', '${primaryUsid}')" title="移动云电脑开机 (支持 SC/ZTE 自适应开机)">🖥️ 开机/唤醒</button>
          <button class="btn btn-tool" onclick="pingYdpcCag('${acc.id}')" title="立即向中兴 CAG 发起 TCP 握手保活">🔄 CAG 握手</button>
          <button class="btn btn-tool" onclick="heartbeatYdpc('${acc.id}')" title="立即发送一次 SOHO 活跃心跳">💓 发送心跳</button>
        </div>
      </div>
    `;

    return card;
  }

  // ====================================================
  // ☁️ 天翼云电脑专属卡片呈现
  // ====================================================
  let sessionBadge = '';
  if (acc.sessionExpired) {
    sessionBadge = `<span class="badge badge-danger" style="cursor:pointer;" onclick="editAccount('${acc.id}')">${!acc.password ? '⚠️ 待扫码授权' : '⚠️ 会话失效'}</span>`;
  }

  const boundBadgeHtml = acc.bound
    ? `<span class="badge badge-online">已绑设备</span>`
    : `<span class="badge badge-warning" style="cursor: pointer;" onclick="openSmsModal('${acc.id}')">⚠️ 待绑定</span>`;

  const officialTaskHtml = buildOfficialTasksHtml(m);

  // 云电脑设备列表渲染
  let desktopsHtml = '';
  const dList = (acc.desktops && acc.desktops.length > 0) ? acc.desktops : [{
    desktopId: m.desktopId || acc.stats?.desktopId || '',
    desktopCode: acc.stats?.desktopId ? String(acc.stats.desktopId).slice(-6) : '',
    desktopName: m.desktopName || '天翼云电脑',
    useStatusText: (acc.stats?.keepAliveStatus === 'online' || m.status === 'online') ? '运行中' : '就绪',
    flavorName: '标准版'
  }];

  if (dList.length > 0) {
    desktopsHtml = `
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px;">
        <div style="font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 6px; display: flex; justify-content: space-between;">
          <span>🖥️ 名下云电脑 (${dList.length}台)</span>
          <span style="color: ${dList.length > 1 ? '#10b981' : '#64748b'}; font-weight: 600;">${dList.length > 1 ? '🟢 全量多机保活已激活' : '多设备独立支持'}</span>
        </div>
          <div style="display: flex; flex-direction: column; gap: 6px;">
            ${dList.map(d => {
              const idText = d.desktopCode || d.desktopId || d.objId || '主设备';
              const isRunning = (d.useStatusText || '').includes('运行') || d.useStatus === 1 || d.useStatus === 0;
              // 前端规格解析 (完全对齐 ctyun-pro parseDesktopSpec 策略)
              const flavor = d.flavorName || '';
              const name = d.desktopName || '';
              let cpuClean = d.cpu ? String(d.cpu).replace(/核+$/g, '') : '';
              let memClean = d.memory ? String(d.memory).replace(/[Gg]+$/g, '') : '';
              if (!cpuClean || !memClean) {
                const explicit = (flavor.match(/(\d+)C(\d+)G/i) || name.match(/(\d+)C(\d+)G/i));
                if (explicit) {
                  cpuClean = cpuClean || explicit[1];
                  memClean = memClean || explicit[2];
                } else {
                  const cn = (flavor + ' ' + name).match(/(\d+)\s*核\s*[/]?\s*(\d+)\s*G/i);
                  if (cn) {
                    cpuClean = cpuClean || cn[1];
                    memClean = memClean || cn[2];
                  }
                }
              }
              // 版本名智能映射兜底 (旗舰16C32G / 尊享·精英8C16G / 标准4C8G / 其余8C16G)
              if (!cpuClean || !memClean) {
                let spec = '8C16G';
                if (name.includes('旗舰版') || flavor.includes('旗舰版')) spec = '16C32G';
                else if (name.includes('尊享版') || flavor.includes('尊享版') || name.includes('精英版') || flavor.includes('精英版')) spec = '8C16G';
                else if (name.includes('标准版') || flavor.includes('标准版')) spec = '4C8G';
                const m2 = spec.match(/(\d+)C(\d+)G/);
                cpuClean = cpuClean || m2[1];
                memClean = memClean || m2[2];
              }
              const specSuffix = ` · ${cpuClean}核/${memClean}G`;
              return `
                <div style="display: flex; justify-content: space-between; align-items: center; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 6px; padding: 6px 10px; font-size: 12px; gap: 8px;">
                  <div style="display: flex; flex-direction: column; min-width: 0; flex: 1; overflow: hidden;">
                    <div style="display: flex; align-items: center; gap: 6px; overflow: hidden; white-space: nowrap;">
                      <span title="${escapeHtml(d.desktopName || '云电脑')}" style="color: #0f172a; font-weight: 700; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; cursor: help;">${escapeHtml(d.desktopName || '云电脑')}</span>
                      ${d.flavorName ? `<span style="font-size: 10.5px; background: #eff6ff; color: #2563eb; padding: 1px 6px; border-radius: 4px; flex-shrink: 0; white-space: nowrap;">${escapeHtml(d.flavorName)}</span>` : ''}
                    </div>
                    <span style="font-size: 11px; color: #64748b; margin-top: 1px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;" title="设备ID: ${escapeHtml(idText)}${escapeHtml(specSuffix)}">ID: ${escapeHtml(idText)}${escapeHtml(specSuffix)}</span>
                  </div>
                  <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0; white-space: nowrap;">
                    <span class="badge ${isRunning ? 'badge-online' : 'badge-offline'}">${isRunning ? '运行中' : '已关机'}</span>
                    <button class="btn btn-sm btn-primary" style="padding: 2px 7px; font-size: 11px; flex-shrink: 0; white-space: nowrap;" onclick="launchWebDesktop('${acc.id}', '${d.desktopId}')">🚀 打开</button>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
      </div>
    `;
  }

  const targetDeviceDisplay = dList.length > 1 
    ? `名下 ${dList.length} 台云电脑 (全量多机守护)` 
    : `${escapeHtml(m.desktopName || dList[0]?.desktopName || '云电脑')} (${escapeHtml(m.currentHost || '已就绪')})`;

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
            <span>${fullPhone}</span>
            <span class="badge" style="background:#eef2ff;color:#4338ca;border:1px solid #c7d2fe;">天翼云</span>
            ${boundBadgeHtml}
            ${sessionBadge}
          </div>
        </div>
      </div>
      <div style="display: flex; gap: 4px;">
        <button class="btn btn-sm" onclick="editAccount('${acc.id}')" title="编辑账号与重新验证">✏️</button>
        <button class="btn btn-sm btn-danger" onclick="deleteAccount('${acc.id}')" title="删除账号">🗑️</button>
      </div>
    </div>

    <!-- 🖥️ 名下云电脑列表 -->
    ${desktopsHtml}

    <!-- 📡 真实 WebSocket 保活心跳状态监视 -->
    <div style="background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; font-size: 12px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
        <span style="color: #2563eb; font-weight: 700;">📡 状态与心跳监视</span>
        <span id="acc-countdown-${acc.id}" style="color: var(--text-muted);">${f.cloudHang && !(m.officialTasks?.find(t => t.name.includes('使用1小时'))?.status === 2) ? `模式: <b style="color:#d97706;">持续挂机累加</b> (剩余: <b style="color:#2563eb;">${m.cycleCountdown || 0}s</b>)` : `脉冲间隔: <b>${acc.pulseIntervalSeconds || 30}s</b> (脉冲倒计时: <b style="color:#16a34a;">${m.cycleCountdown || 30}s</b>)`}</span>
      </div>
      <div style="color: #475569; line-height: 1.8;">
        <div style="display: flex; align-items: baseline; gap: 4px; overflow: hidden; white-space: nowrap;">
          <span style="flex-shrink: 0;">目标设备:</span>
          <span id="acc-host-${acc.id}" title="${targetDeviceDisplay}" style="color: #0f172a; font-weight: 600; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; flex: 1; cursor: help;">${targetDeviceDisplay}</span>
        </div>
        <div style="display: flex; align-items: baseline; gap: 4px; overflow: hidden; white-space: nowrap;">
          <span style="flex-shrink: 0;">当前动作:</span>
          <span id="acc-hb-text-${acc.id}" title="${escapeHtml(m.lastHeartbeatResult || '正在建立心跳通道...')}" style="color: ${(m.lastHeartbeatResult || '').includes('避让') ? '#d97706' : '#16a34a'}; font-weight: 600; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; flex: 1; cursor: help;">${escapeHtml(m.lastHeartbeatResult || '正在建立心跳通道...')}</span>
        </div>
        <div>成功轮次: <span id="acc-success-count-${acc.id}" style="color: #2563eb; font-weight: 600;">${m.successCount || 0} 轮</span></div>
      </div>
    </div>

    <!-- 🏆 天翼云官方真实任务看板 (精致可折叠设计，状态持久化) -->
    <details style="background: #ffffff; border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; font-size: 13px;" ${isDetailsOpen(acc.id, 'tasks') ? 'open' : ''} ontoggle="saveDetailsState('${acc.id}', 'tasks', this.open)">
      <summary style="display: flex; justify-content: space-between; align-items: center; cursor: pointer; font-weight: 700; user-select: none;">
        <span style="color: #b45309;">🏆 官方任务进度 (总分: <b id="acc-points-val-${acc.id}" style="color:#16a34a;">${m.userPoints || 0}</b>)</span>
        <span style="font-size: 11px; color: var(--text-muted); font-weight: normal;">点击收起/展开</span>
      </summary>
      <div id="acc-tasks-list-${acc.id}" style="display: flex; flex-direction: column; gap: 6px; margin-top: 10px;">
        ${officialTaskHtml}
      </div>
    </details>

    <!-- 功能开关 (精致折叠设计，状态持久化) -->
    <details class="features-box" style="padding: 10px 14px;" ${isDetailsOpen(acc.id, 'features') ? 'open' : ''} ontoggle="saveDetailsState('${acc.id}', 'features', this.open)">
      <summary style="display: flex; justify-content: space-between; align-items: center; cursor: pointer; font-size: 12.5px; font-weight: 700; color: #334155; user-select: none; margin-bottom: 2px;">
        <span>⚙️ 自动化任务与保活开关</span>
        <span style="font-size: 11px; color: var(--text-muted); font-weight: normal;">点击收起/展开</span>
      </summary>
      <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
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
    </details>

    <!-- 快捷操作按钮 -->
    <div class="card-actions">
      ${acc.sessionExpired ? `
        <button class="btn btn-danger btn-launch-full" onclick="editAccount('${acc.id}')" style="margin-bottom:6px;">
          <span>${!acc.password ? '📱 重新扫码授权' : '🔑 重新验证登录'}</span>
          <span class="btn-subtext">${!acc.password ? '手机 App 扫码一键恢复 ➔' : '输验证码恢复 ➔'}</span>
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

  return card;
}

// 原地静默增量局部数据更新 (100% 杜绝 DOM 结构重绘与滚动条跳跃)
function updateAccountsInPlace(filteredAccounts) {
  filteredAccounts.forEach(acc => {
    const card = document.getElementById(`acc-card-${acc.id}`);
    if (!card) return;

    const isYdpc = acc.platform === 'ydpc';
    const isYdpcRealOnline = isYdpc 
      ? (acc.liveMetrics?.status === "online") 
      : (acc.stats?.keepAliveStatus === "online" || acc.liveMetrics?.status === "online");
    const m = acc.liveMetrics || {};
    const f = acc.features || {};

    // 1. 更新保活状态徽章
    const statusBadgeEl = document.getElementById(`acc-status-badge-${acc.id}`);
    if (statusBadgeEl) {
      statusBadgeEl.innerHTML = isYdpcRealOnline 
        ? `<span class="badge badge-online">保活在线</span>`
        : `<span class="badge badge-offline">离线待机</span>`;
    }

    // 2. 更新心跳/动作文本
    const hbTextEl = document.getElementById(`acc-hb-text-${acc.id}`);
    if (hbTextEl) {
      const hbResult = m.lastHeartbeatResult || (isYdpc ? '保活巡检待命' : '正在建立心跳通道...');
      hbTextEl.innerText = hbResult;
      hbTextEl.title = hbResult;
      if (!isYdpc) {
        hbTextEl.style.color = hbResult.includes('避让') ? '#d97706' : '#16a34a';
      }
    }

    // 3. 更新倒计时与轮次 (天翼云)
    const cdEl = document.getElementById(`acc-countdown-${acc.id}`);
    if (cdEl) {
      cdEl.innerHTML = f.cloudHang && !(m.officialTasks?.find(t => t.name.includes('使用1小时'))?.status === 2)
        ? `模式: <b style="color:#d97706;">持续挂机累加</b> (剩余: <b style="color:#2563eb;">${m.cycleCountdown || 0}s</b>)`
        : `脉冲间隔: <b>${acc.pulseIntervalSeconds || 30}s</b> (脉冲倒计时: <b style="color:#16a34a;">${m.cycleCountdown || 30}s</b>)`;
    }

    const successEl = document.getElementById(`acc-success-count-${acc.id}`);
    if (successEl) {
      successEl.innerText = `${m.successCount || 0} 轮`;
    }

    // 4. 更新移动云上次活跃时间
    const activeInfoEl = document.getElementById(`acc-active-info-${acc.id}`);
    if (activeInfoEl) {
      activeInfoEl.innerHTML = `上次活跃: <span style="color: #0f172a; font-weight: 600;">${m.lastHeartbeatTime || acc.stats?.lastKeepAliveTime || '刚刚'}</span> · 周期: <b>${Math.round((acc.keepaliveInterval || 600) / 60)} 分钟</b>`;
    }

    // 5. 更新官方任务积分与列表 (天翼云)
    const pointsValEl = document.getElementById(`acc-points-val-${acc.id}`);
    if (pointsValEl) {
      pointsValEl.innerText = m.userPoints || 0;
    }

    const tasksListEl = document.getElementById(`acc-tasks-list-${acc.id}`);
    if (tasksListEl && m.officialTasks && m.officialTasks.length > 0) {
      tasksListEl.innerHTML = buildOfficialTasksHtml(m);
    }
  });
}

// 账号卡片 HTML 模板生成
function renderAccounts(isSilent = false) {
  const container = document.getElementById("accounts-container");
  if (!container) return;

  // 1. 如果用户正在拖拽卡片或正在行内编辑备注名，跳过重绘避免打断交互
  if (draggedAccId || activeEditingAccId) return;

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

  // 智能切换平台视图 Tab 栏：只有当同时存在天翼云和移动云两种设备时才显示 Tab，单一平台时自动隐藏
  const hasCtyun = (accounts || []).some(a => a.platform === 'ctyun' || !a.platform);
  const hasYdpc = (accounts || []).some(a => a.platform === 'ydpc');
  const viewTabsGroup = document.getElementById("account-view-tabs-group");
  if (viewTabsGroup) {
    if (hasCtyun && hasYdpc) {
      viewTabsGroup.style.display = "flex";
    } else {
      viewTabsGroup.style.display = "none";
      activeAccountViewTab = 'all'; // 自动还原
    }
  }

  // 根据当前视图过滤账号
  const filteredAccounts = getFilteredAccounts();

  if (!filteredAccounts || filteredAccounts.length === 0) {
    const tabName = activeAccountViewTab === 'ydpc' ? '中国移动云电脑' : (activeAccountViewTab === 'ctyun' ? '天翼云电脑' : '云电脑');
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted); background: var(--bg-secondary); border-radius: var(--radius); border: 1px dashed var(--border);">
        <p style="font-size: 15px; margin-bottom: 12px;">当前暂未配置【${tabName}】设备</p>
        <button class="btn btn-primary" onclick="openAddAccountModal()">➕ 立即添加云电脑</button>
      </div>
    `;
    return;
  }

  const cols = getGridColumns();
  const slots = loadGridSlots(filteredAccounts, cols);

  // 2. 检查是否可无感局部原地更新 (In-Place Update)
  // 如果现有的 DOM 卡片结构和 slots 一致，直接更新动态文本与指标，100% 避免销毁 DOM 和触发表单/滚动条复位！
  if (isSilent) {
    const existingChildren = container.children;
    let matchExact = existingChildren.length === slots.length;
    if (matchExact) {
      for (let i = 0; i < slots.length; i++) {
        const expectedAccId = slots[i];
        const el = existingChildren[i];
        if (!expectedAccId) {
          if (!el.classList.contains("grid-empty-slot")) { matchExact = false; break; }
        } else {
          if (!el.classList.contains("account-card") || el.dataset.accId !== expectedAccId) { matchExact = false; break; }
        }
      }
    }

    if (matchExact) {
      updateAccountsInPlace(filteredAccounts);
      return;
    }
  }

  // 3. 结构发生变动时的平滑重绘：锁定高度与滚动位置
  const prevScrollY = window.scrollY || window.pageYOffset || 0;
  const currentHeight = container.offsetHeight;
  if (currentHeight > 0) {
    container.style.minHeight = `${currentHeight}px`;
  }

  const fragment = document.createDocumentFragment();

  slots.forEach((accId, slotIndex) => {
    if (!accId) {
      const emptySlot = document.createElement("div");
      emptySlot.className = "grid-empty-slot";
      emptySlot.dataset.slot = slotIndex;
      emptySlot.innerHTML = "";
      emptySlot.addEventListener("dragover", handleSlotDragOver);
      emptySlot.addEventListener("dragleave", handleSlotDragLeave);
      emptySlot.addEventListener("drop", handleSlotDrop);
      fragment.appendChild(emptySlot);
      return;
    }

    const acc = filteredAccounts.find(a => a.id === accId);
    if (!acc) return;

    const card = buildAccountCardElement(acc, slotIndex);
    fragment.appendChild(card);
  });

  container.innerHTML = "";
  container.appendChild(fragment);

  // 渲染完成释放高度并确保滚动位置绝对稳定
  requestAnimationFrame(() => {
    container.style.minHeight = "";
    if (Math.abs(window.scrollY - prevScrollY) > 2) {
      window.scrollTo({ top: prevScrollY, behavior: "instant" });
    }
  });
}

// ==========================================
// 卡片自由网格插槽拖拽交互与持久化
// ==========================================
let draggedCardEl = null;
let draggedAccId = null;
let draggedSlotIndex = null;

function handleCardDragStart(e) {
  draggedCardEl = this;
  draggedAccId = this.dataset.accId;
  draggedSlotIndex = parseInt(this.dataset.slot, 10);
  this.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", draggedAccId);

  // 激活所有可放置空位插槽的高亮
  document.querySelectorAll(".grid-empty-slot").forEach(s => s.classList.add("droppable"));
}

function handleCardDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  if (this !== draggedCardEl) {
    this.classList.add("drag-over");
  }
}

function handleCardDragLeave(e) {
  this.classList.remove("drag-over");
}

function handleSlotDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  this.classList.add("drag-over");
}

function handleSlotDragLeave(e) {
  this.classList.remove("drag-over");
}

function handleSlotDrop(e) {
  e.preventDefault();
  this.classList.remove("drag-over");
  const targetSlot = parseInt(this.dataset.slot, 10);
  if (isNaN(targetSlot) || isNaN(draggedSlotIndex) || targetSlot === draggedSlotIndex || !draggedAccId) return;

  const cols = getGridColumns();
  const currentAccs = getFilteredAccounts();
  const slots = loadGridSlots(currentAccs, cols);

  // 移动卡片到目标空位插槽
  slots[draggedSlotIndex] = null;
  slots[targetSlot] = draggedAccId;

  saveGridSlots(slots);
  renderAccounts();
  saveAccountsOrderFromSlots(slots);
}

function handleCardDrop(e) {
  e.preventDefault();
  this.classList.remove("drag-over");
  const targetSlot = parseInt(this.dataset.slot, 10);
  if (isNaN(targetSlot) || isNaN(draggedSlotIndex) || targetSlot === draggedSlotIndex || !draggedAccId) return;

  const cols = getGridColumns();
  const currentAccs = getFilteredAccounts();
  const slots = loadGridSlots(currentAccs, cols);

  // 互换两个插槽的内容
  const temp = slots[targetSlot];
  slots[targetSlot] = draggedAccId;
  slots[draggedSlotIndex] = temp;

  saveGridSlots(slots);
  renderAccounts();
  saveAccountsOrderFromSlots(slots);
}

function handleCardDragEnd(e) {
  this.classList.remove("dragging");
  draggedCardEl = null;
  draggedAccId = null;
  draggedSlotIndex = null;
  document.querySelectorAll(".account-card, .grid-empty-slot").forEach(c => {
    c.classList.remove("drag-over");
    c.classList.remove("droppable");
  });
}

function saveAccountsOrderFromSlots(slots) {
  const orderedIds = slots.filter(Boolean);
  for (const a of accounts) {
    if (!orderedIds.includes(a.id)) orderedIds.push(a.id);
  }
  accounts.sort((a, b) => {
    const idxA = orderedIds.indexOf(a.id);
    const idxB = orderedIds.indexOf(b.id);
    return (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
  });
  saveAccountsOrder();
}

async function saveAccountsOrder() {
  const orderedIds = accounts.map(a => a.id);
  try {
    await authFetch("/api/accounts/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedIds })
    });
  } catch (e) {}
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

      // 启动 2 秒轮询看门狗 (携带用户填写的账号备注名与目标重登账号ID)
      const nameVal = document.getElementById("qrcode-acc-name") ? document.getElementById("qrcode-acc-name").value.trim() : "";
      const currentAccId = document.getElementById("acc-id") ? document.getElementById("acc-id").value : "";
      const accIdParam = currentAccId ? `&accId=${encodeURIComponent(currentAccId)}` : "";
      qrPollingTimer = setInterval(async () => {
        try {
          const sRes = await authFetch(`/api/account/qrcode/status?qrCodeId=${encodeURIComponent(currentQrCodeId)}&deviceCode=${encodeURIComponent(data.deviceCode)}&accountName=${encodeURIComponent(nameVal)}${accIdParam}`);
          const sData = await sRes.json();
          if (sData.success) {
            if (sData.codeStatus === 'scaned') {
              if (hintEl) { hintEl.innerText = "📱 手机端已扫描，请在手机上点击【确认登录】..."; hintEl.style.color = "#16a34a"; }
            } else if (sData.codeStatus === 'authorize') {
              if (qrPollingTimer) { clearInterval(qrPollingTimer); qrPollingTimer = null; }
              showToast(sData.isReAuth ? "🎉 官方扫码重新授权成功！已恢复在线保活！" : "🎉 官方扫码授权成功！云电脑已上线！", "success");
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
  document.getElementById("acc-id").value = "";
  document.getElementById("acc-name").value = "";
  document.getElementById("acc-user").value = "";
  document.getElementById("acc-password").value = "";
  document.getElementById("acc-captcha-code").value = "";
  document.getElementById("acc-device-code").value = "";
  const qrNameEl = document.getElementById("qrcode-acc-name");
  if (qrNameEl) qrNameEl.value = "";
  const ydNameEl = document.getElementById("ydpc-name");
  if (ydNameEl) ydNameEl.value = "";
  const ydUserEl = document.getElementById("ydpc-user");
  if (ydUserEl) ydUserEl.value = "";
  const ydPwdEl = document.getElementById("ydpc-password");
  if (ydPwdEl) ydPwdEl.value = "";
  const ydCaptchaCode = document.getElementById("ydpc-captcha-code");
  if (ydCaptchaCode) ydCaptchaCode.value = "";
  const ydRandomCode = document.getElementById("ydpc-random-code");
  if (ydRandomCode) ydRandomCode.value = "";
  const ydImg = document.getElementById("ydpc-captcha-img");
  if (ydImg) ydImg.style.display = "none";
  const ydLoading = document.getElementById("ydpc-captcha-loading");
  if (ydLoading) {
    ydLoading.style.display = "inline";
    ydLoading.innerText = "点击获取验证码";
  }

  const platformTabs = document.getElementById("platform-tabs-container");
  if (platformTabs) platformTabs.style.display = "flex";

  openModal("account-modal");
  switchAddAccountPlatform('ctyun');
}

async function refreshYdpcModalCaptcha() {
  const imgEl = document.getElementById("ydpc-captcha-img");
  const loadingEl = document.getElementById("ydpc-captcha-loading");
  const randomCodeEl = document.getElementById("ydpc-random-code");

  if (loadingEl) {
    loadingEl.style.display = "inline";
    loadingEl.innerText = "获取中...";
  }
  if (imgEl) imgEl.style.display = "none";

  try {
    const res = await authFetch('/api/ydpc/captcha');
    const data = await res.json();
    if (res.ok && data.success && data.image) {
      if (randomCodeEl) randomCodeEl.value = data.randomCode || '';
      if (imgEl) {
        imgEl.src = data.image;
        imgEl.style.display = "block";
      }
      if (loadingEl) loadingEl.style.display = "none";
    } else {
      if (loadingEl) loadingEl.innerText = "获取失败，点击重试";
    }
  } catch (e) {
    if (loadingEl) loadingEl.innerText = "获取失败，点击重试";
  }
}

function switchAddAccountPlatform(platform) {
  currentAddPlatform = platform;
  const tabCt = document.getElementById("platform-tab-ctyun");
  const tabYd = document.getElementById("platform-tab-ydpc");
  const panelCt = document.getElementById("panel-add-ctyun");
  const panelYd = document.getElementById("panel-add-ydpc");
  const btnSaveCt = document.getElementById("btn-save-account-pwd");
  const btnSaveYd = document.getElementById("btn-save-account-ydpc");
  const modalTitle = document.getElementById("modal-account-title");

  if (platform === 'ydpc') {
    if (tabCt) tabCt.className = "btn btn-sm";
    if (tabYd) tabYd.className = "btn btn-sm btn-primary";
    if (panelCt) panelCt.classList.add("hidden");
    if (panelYd) panelYd.classList.remove("hidden");
    if (btnSaveCt) btnSaveCt.style.display = "none";
    if (btnSaveYd) btnSaveYd.style.display = "inline-block";
    if (modalTitle) modalTitle.innerText = "添加中国移动云电脑";
    if (qrPollingTimer) { clearInterval(qrPollingTimer); qrPollingTimer = null; }
  } else {
    if (tabCt) tabCt.className = "btn btn-sm btn-primary";
    if (tabYd) tabYd.className = "btn btn-sm";
    if (panelCt) panelCt.classList.remove("hidden");
    if (panelYd) panelYd.classList.add("hidden");
    if (btnSaveYd) btnSaveYd.style.display = "none";
    if (modalTitle) modalTitle.innerText = "添加天翼云电脑账号";
    switchAccountLoginTab('qrcode');
  }
}

async function saveYdpcAccount() {
  const accId = document.getElementById("acc-id") ? document.getElementById("acc-id").value : "";
  const name = document.getElementById("ydpc-name") ? document.getElementById("ydpc-name").value.trim() : "";
  const user = document.getElementById("ydpc-user") ? document.getElementById("ydpc-user").value.trim() : "";
  const password = document.getElementById("ydpc-password") ? document.getElementById("ydpc-password").value.trim() : "";
  const accountType = document.getElementById("ydpc-account-type") ? document.getElementById("ydpc-account-type").value : "main";
  const keepaliveInterval = document.getElementById("ydpc-interval") ? parseInt(document.getElementById("ydpc-interval").value) || 600 : 600;
  const autoBoot = document.getElementById("ydpc-autoboot") ? document.getElementById("ydpc-autoboot").checked : true;
  const verificationCode = document.getElementById("ydpc-captcha-code") ? document.getElementById("ydpc-captcha-code").value.trim() : "";
  const randomCode = document.getElementById("ydpc-random-code") ? document.getElementById("ydpc-random-code").value.trim() : "";

  if (!user || !password) {
    showToast("请输入移动云手机号和密码", "error");
    return;
  }

  if (accId) {
    // 编辑修改模式
    showToast("正在保存移动云账号修改并重新同步...", "info");
    try {
      const res = await authFetch(`/api/accounts/${accId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name || user,
          user,
          password,
          accountType,
          keepaliveInterval,
          features: { autoBoot, cagKeepAlive: true, sohoHeartbeat: true, keepAlive: true }
        })
      });
      const data = await res.json();
      if (res.ok) {
        showToast("🎉 移动云账号修改已保存！", "success");
        closeModal("account-modal");
        await loadAccounts(true);
      } else {
        showToast(data.error || "更新失败", "error");
      }
    } catch (e) {
      showToast("网络请求异常: " + e.message, "error");
    }
    return;
  }

  // 新增模式
  showToast("正在向中国移动 SOHO 中心验证并拉取云电脑...", "info");
  try {
    const res = await authFetch("/api/accounts/ydpc/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, user, password, accountType, keepaliveInterval, autoBoot, verificationCode, randomCode })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("🎉 移动云电脑添加成功！已自动开启保活守护", "success");
      closeModal("account-modal");
      await loadAccounts(true);
    } else {
      const errMsg = data.error || "添加移动云电脑失败";
      showToast(errMsg, "error");
      if (errMsg.includes("验证码")) {
        // 自动拉取图形验证码并聚焦
        refreshYdpcModalCaptcha();
        const codeInput = document.getElementById("ydpc-captcha-code");
        if (codeInput) {
          codeInput.focus();
          codeInput.select();
        }
      }
    }
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
  }
}

function editAccount(accId) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  document.getElementById("acc-id").value = acc.id;

  const platformTabs = document.getElementById("platform-tabs-container");
  if (platformTabs) platformTabs.style.display = "none"; // 编辑模式锁定平台

  if (acc.platform === 'ydpc') {
    document.getElementById("modal-account-title").innerText = "编辑中国移动云电脑账号";
    const nameEl = document.getElementById("ydpc-name");
    const userEl = document.getElementById("ydpc-user");
    const pwdEl = document.getElementById("ydpc-password");
    const typeEl = document.getElementById("ydpc-account-type");
    const intEl = document.getElementById("ydpc-interval");
    const bootEl = document.getElementById("ydpc-autoboot");

    if (nameEl) nameEl.value = acc.name || "";
    if (userEl) userEl.value = acc.user || "";
    if (pwdEl) pwdEl.value = acc.password || "";
    if (typeEl) typeEl.value = acc.accountType || "main";
    if (intEl) intEl.value = String(acc.keepaliveInterval || 600);
    if (bootEl) bootEl.checked = acc.features?.autoBoot !== false;

    openModal("account-modal");
    switchAddAccountPlatform('ydpc');
  } else {
    const isQrAccount = !acc.password;
    if (isQrAccount) {
      document.getElementById("modal-account-title").innerText = acc.sessionExpired 
        ? `📱 重新扫码授权天翼云账号 [${acc.name || acc.user}]` 
        : `📱 重新扫码授权 [${acc.name || acc.user}]`;
      const qrNameEl = document.getElementById("qrcode-acc-name");
      if (qrNameEl) qrNameEl.value = acc.name || "";
      const tabContainer = document.getElementById("acc-login-tabs");
      if (tabContainer) tabContainer.style.display = "none";
      openModal("account-modal");
      switchAddAccountPlatform('ctyun');
      switchAccountLoginTab('qrcode');
    } else {
      document.getElementById("modal-account-title").innerText = acc.sessionExpired 
        ? `⚠️ 重新验证天翼云账号 [${acc.name || acc.user}]` 
        : `编辑天翼云账号 [${acc.name || acc.user}]`;
      document.getElementById("acc-name").value = acc.name || "";
      document.getElementById("acc-user").value = acc.user || "";
      document.getElementById("acc-password").value = acc.password || "";
      document.getElementById("acc-captcha-code").value = "";
      document.getElementById("acc-device-code").value = acc.deviceCode || "";
      const tabContainer = document.getElementById("acc-login-tabs");
      if (tabContainer) tabContainer.style.display = "none";
      openModal("account-modal");
      switchAddAccountPlatform('ctyun');
      switchAccountLoginTab('pwd');
      setTimeout(refreshModalCaptcha, 300);
    }
  }
}

async function bootYdpcVm(accId, userServiceId) {
  const acc = accounts.find(a => a.id === accId);
  const targetUsid = userServiceId || (acc?.vms?.[0]?.userServiceId) || (acc?.desktops?.[0]?.userServiceId);
  showToast("正在执行移动云开机/唤醒指令...", "info");
  try {
    const res = await authFetch(`/api/accounts/${accId}/power/poweron`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userServiceId: targetUsid })
    });
    const data = await res.json();
    if (res.ok && (data.success || data.code === 2000)) {
      showToast("✅ " + (data.message || "开机指令已生效！"), "success");
      await loadAccounts(true);
    } else {
      showToast("开机未成功: " + (data.error || data.msg || "网关拒绝"), "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

async function pingYdpcCag(accId, userServiceId) {
  const acc = accounts.find(a => a.id === accId);
  const targetUsid = userServiceId || (acc?.vms?.[0]?.userServiceId) || (acc?.desktops?.[0]?.userServiceId);
  showToast("正在向中兴 CAG 发起三阶段 TCP 握手...", "info");
  try {
    const res = await authFetch(`/api/ydpc/${accId}/cag-ping`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userServiceId: targetUsid })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("🟢 ZTEC CAG 握手成功！网关返回 200 OK", "success");
      await loadAccounts(true);
    } else {
      showToast("CAG 握手失败: " + (data.error || "超时"), "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

async function heartbeatYdpc(accId, userServiceId) {
  const acc = accounts.find(a => a.id === accId);
  const targetUsid = userServiceId || (acc?.vms?.[0]?.userServiceId) || (acc?.desktops?.[0]?.userServiceId);
  showToast("正在发送 SOHO 心跳保持...", "info");
  try {
    const res = await authFetch(`/api/ydpc/${accId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userServiceId: targetUsid })
    });
    const data = await res.json();
    if (res.ok && (data.code === 2000 || data.code === 0 || data.success)) {
      showToast("💓 SOHO 心跳保持成功！", "success");
      await loadAccounts(true);
    } else {
      showToast("心跳异常: " + (data.msg || data.error || "失败"), "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
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
async function openPowerModal(accId, desktopId = '', desktopName = '') {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  document.getElementById("power-acc-id").value = acc.id;
  currentPowerDesktopId = desktopId || '';

  const select = document.getElementById("power-desktop-select");
  select.innerHTML = "<option value=''>正在获取名下云电脑...</option>";
  document.getElementById("power-desktop-status").innerHTML = `<span style="color: #64748b;">检测中...</span>`;
  openModal("power-modal");

  if (acc.platform === 'ydpc') {
    const vms = (acc.vms && acc.vms.length > 0) ? acc.vms : (acc.desktops || []);
    const localList = vms.map(v => ({
      desktopId: String(v.userServiceId),
      desktopName: v.vmName || '中国移动云电脑',
      useStatusText: v.vmStatus || '未知',
      flavorName: v.cpu ? `${v.cpu}核/${v.memory}G` : ''
    }));
    renderPowerDesktopSelect(localList, desktopId);
    return;
  }

  // 天翼云
  const localList = (acc.desktops && acc.desktops.length > 0) ? acc.desktops : (acc.liveMetrics?.desktopName ? [{
    desktopId: acc.liveMetrics?.desktopId || acc.stats?.desktopId || '0',
    desktopName: acc.liveMetrics?.desktopName,
    useStatusText: '运行中',
    flavorName: ''
  }] : []);

  renderPowerDesktopSelect(localList, desktopId);

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
  const acc = accounts.find(a => a.id === accId);
  const actionNames = { poweron: '开机 / 唤醒', reboot: '重启', shutdown: '关机' };
  const actionName = actionNames[action] || action;

  if (action === 'shutdown' || action === 'reboot') {
    if (!confirm(`确认要对云电脑下达【${actionName}】指令吗？未保存的数据可能会丢失。`)) {
      return;
    }
  }

  if (acc && acc.platform === 'ydpc') {
    showToast(`正在向移动云下发【${actionName}】指令...`, "info");
    try {
      const res = await authFetch(`/api/accounts/${accId}/power/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userServiceId: currentPowerDesktopId })
      });
      const data = await res.json();
      if (res.ok && (data.success || data.code === 2000)) {
        showToast(data.message || `【${actionName}】指令已生效！`, "success");
        closeModal("power-modal");
        await loadAccounts(true);
      } else {
        showToast(`操作未成功: ${data.error || data.msg || '网关拒绝'}`, "error");
      }
    } catch (e) {
      showToast("请求异常: " + e.message, "error");
    }
    return;
  }

  // 天翼云
  showToast(`正在向天翼云下发【${actionName}】指令...`, "info");
  try {
    const query = currentPowerDesktopId ? `?desktopId=${encodeURIComponent(currentPowerDesktopId)}` : '';
    const res = await authFetch(`/api/accounts/${accId}/power/${action}${query}`, { method: "POST" });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message || `【${actionName}】指令下达成功！`, "success");
      closeModal("power-modal");
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

// 8. 全局系统与平台调度设置 (仅管理员)
async function openSettingsModal() {
  try {
    const res = await authFetch("/api/settings");
    if (!res.ok) {
      if (res.status === 403) {
        showToast("权限不足：仅管理员可访问全局系统设置", "error");
        return;
      }
      showToast("获取系统设置失败", "error");
      return;
    }
    const settings = await res.json();

    const c = settings.cron || {};
    if (document.getElementById("set-system-title")) {
      document.getElementById("set-system-title").value = settings.systemTitle || "天翼云/移动云电脑保活签到中心";
    }
    if (document.getElementById("set-system-subtitle")) {
      document.getElementById("set-system-subtitle").value = settings.systemSubtitle || "多账号长连接保活守护 · 多运营商支持 · 每日签到打卡 · 智能挂机";
    }
    if (document.getElementById("cron-task-time")) {
      document.getElementById("cron-task-time").value = c.executeTime || "01:20";
    }
    const enableSub = c.enableSubCron === true;
    if (document.getElementById("cron-enable-sub")) {
      document.getElementById("cron-enable-sub").checked = enableSub;
    }
    if (document.getElementById("cron-sign")) document.getElementById("cron-sign").value = c.signCron || "";
    if (document.getElementById("cron-aichat")) document.getElementById("cron-aichat").value = c.aiChatCron || "";
    if (document.getElementById("cron-hang")) document.getElementById("cron-hang").value = c.cloudHangCron || "";
    if (document.getElementById("cron-redeem")) document.getElementById("cron-redeem").value = c.redeemCron || "";
    toggleSubCronInputs(enableSub);

    if (document.getElementById("set-keepalive-sec")) {
      document.getElementById("set-keepalive-sec").value = settings.keepAliveSeconds || 60;
    }
    if (document.getElementById("set-pulse-sec")) {
      document.getElementById("set-pulse-sec").value = settings.pulseIntervalSeconds || 30;
    }
    if (document.getElementById("set-allow-reg")) {
      document.getElementById("set-allow-reg").checked = settings.allowRegistration === true;
    }
    if (document.getElementById("set-default-quota")) {
      document.getElementById("set-default-quota").value = settings.defaultQuota || 2;
    }

    openModal("settings-modal");
  } catch (e) {
    showToast("获取设置失败: " + e.message, "error");
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

async function saveSettings() {
  const customTitle = document.getElementById("set-system-title") ? document.getElementById("set-system-title").value.trim() : "";
  const customSubtitle = document.getElementById("set-system-subtitle") ? document.getElementById("set-system-subtitle").value.trim() : "";
  const payload = {
    systemTitle: customTitle || "天翼云/移动云电脑保活签到中心",
    systemSubtitle: customSubtitle || "多账号长连接保活守护 · 多运营商支持 · 每日签到打卡 · 智能挂机",
    keepAliveSeconds: parseInt(document.getElementById("set-keepalive-sec") ? document.getElementById("set-keepalive-sec").value : 60) || 60,
    pulseIntervalSeconds: Math.min(3300, Math.max(10, parseInt(document.getElementById("set-pulse-sec") ? document.getElementById("set-pulse-sec").value : 30) || 30)),
    allowRegistration: document.getElementById("set-allow-reg") ? document.getElementById("set-allow-reg").checked : false,
    defaultQuota: document.getElementById("set-default-quota") ? parseInt(document.getElementById("set-default-quota").value) || 2 : 2,
    cron: {
      executeTime: document.getElementById("cron-task-time") ? document.getElementById("cron-task-time").value.trim() : "01:20",
      enableSubCron: document.getElementById("cron-enable-sub") ? document.getElementById("cron-enable-sub").checked : false,
      signCron: document.getElementById("cron-sign") ? document.getElementById("cron-sign").value.trim() : "",
      aiChatCron: document.getElementById("cron-aichat") ? document.getElementById("cron-aichat").value.trim() : "",
      cloudHangCron: document.getElementById("cron-hang") ? document.getElementById("cron-hang").value.trim() : "",
      redeemCron: document.getElementById("cron-redeem") ? document.getElementById("cron-redeem").value.trim() : ""
    }
  };

  try {
    const res = await authFetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      showToast("全局系统设置已成功更新！调度已即时热重载", "success");
      closeModal("settings-modal");
      if (payload.systemTitle) {
        const titleEl = document.getElementById("main-system-title");
        if (titleEl) titleEl.innerText = payload.systemTitle;
        document.title = `${payload.systemTitle} - 多账号保活控制台`;
      }
      if (payload.systemSubtitle) {
        const subtitleEl = document.querySelector(".title-group p");
        if (subtitleEl) subtitleEl.innerText = payload.systemSubtitle;
      }
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || "更新失败", "error");
    }
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
  }
}

// 8.5 个人消息通知推送设置 (所有用户通用)
async function openUserNotifyModal() {
  try {
    const res = await authFetch("/api/user/notify");
    if (!res.ok) {
      showToast("获取个人通知设置失败", "error");
      return;
    }
    const notify = await res.json();

    if (document.getElementById("user-notify-enabled")) {
      document.getElementById("user-notify-enabled").checked = !!notify.enabled;
    }
    if (document.getElementById("user-notify-channel")) {
      document.getElementById("user-notify-channel").value = notify.channel || "webhook";
    }
    if (document.getElementById("user-notify-token")) {
      document.getElementById("user-notify-token").value = notify.webhookUrl || "";
    }
    if (document.getElementById("user-notify-title-tpl")) {
      document.getElementById("user-notify-title-tpl").value = notify.customTitleTemplate || "";
    }
    if (document.getElementById("user-notify-content-tpl")) {
      document.getElementById("user-notify-content-tpl").value = notify.customContentTemplate || "";
    }
    onUserNotifyChannelChange(false);
    openModal("user-notify-modal");
  } catch (e) {
    showToast("获取个人通知设置失败: " + e.message, "error");
  }
}

function onUserNotifyChannelChange(isUserSwitch = true) {
  const channelEl = document.getElementById("user-notify-channel");
  const label = document.getElementById("user-notify-token-label");
  const input = document.getElementById("user-notify-token");
  if (!channelEl || !label || !input) return;

  const channel = channelEl.value;
  const currentVal = input.value.trim();

  // 若用户主动在下拉列表中切换通道类型，且当前输入框中残留了其他通道的特征链接，自动清空避免跨渠道残留
  if (isUserSwitch && currentVal) {
    const isOtherChannelUrl = 
      (channel !== "feishu" && currentVal.includes("open.feishu.cn")) ||
      (channel !== "qywx" && currentVal.includes("qyapi.weixin.qq.com")) ||
      (channel !== "dingtalk" && currentVal.includes("oapi.dingtalk.com")) ||
      (channel !== "bark" && currentVal.includes("api.day.app")) ||
      (channel !== "pushplus" && currentVal.includes("pushplus.plus")) ||
      (channel !== "serverchan" && currentVal.includes("ftqq.com")) ||
      (channel !== "telegram" && currentVal.includes("api.telegram.org"));
    if (isOtherChannelUrl) {
      input.value = "";
    }
  }

  if (channel === "qywx") {
    label.innerText = "企业微信机器人 Webhook 地址";
    input.placeholder = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx";
  } else if (channel === "dingtalk") {
    label.innerText = "钉钉机器人 Webhook 地址";
    input.placeholder = "https://oapi.dingtalk.com/robot/send?access_token=xxxx";
  } else if (channel === "feishu") {
    label.innerText = "飞书机器人 Webhook 地址";
    input.placeholder = "https://open.feishu.cn/open-apis/bot/v2/hook/xxxx";
  } else if (channel === "serverchan") {
    label.innerText = "Server酱 SendKey";
    input.placeholder = "请输入 SendKey (SCTxxxx)";
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

async function testUserNotify() {
  const channel = document.getElementById("user-notify-channel") ? document.getElementById("user-notify-channel").value : "webhook";
  const webhookUrl = document.getElementById("user-notify-token") ? document.getElementById("user-notify-token").value.trim() : "";
  const customTitleTemplate = document.getElementById("user-notify-title-tpl") ? document.getElementById("user-notify-title-tpl").value.trim() : "";
  const customContentTemplate = document.getElementById("user-notify-content-tpl") ? document.getElementById("user-notify-content-tpl").value.trim() : "";

  if (!webhookUrl) {
    showToast("请先输入推送地址或 Token", "error");
    return;
  }

  showToast("正在发送测试推送...", "info");
  try {
    const res = await authFetch("/api/user/notify/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, webhookUrl, customTitleTemplate, customContentTemplate })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("🎉 推送成功！已向您的专属通道发送测试卡片", "success");
    } else {
      showToast(`推送失败: ${data.message || '网络无法连通或已被系统安全拦截'}`, "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

async function saveUserNotify() {
  const payload = {
    enabled: document.getElementById("user-notify-enabled") ? document.getElementById("user-notify-enabled").checked : false,
    channel: document.getElementById("user-notify-channel") ? document.getElementById("user-notify-channel").value : "webhook",
    webhookUrl: document.getElementById("user-notify-token") ? document.getElementById("user-notify-token").value.trim() : "",
    customTitleTemplate: document.getElementById("user-notify-title-tpl") ? document.getElementById("user-notify-title-tpl").value.trim() : "",
    customContentTemplate: document.getElementById("user-notify-content-tpl") ? document.getElementById("user-notify-content-tpl").value.trim() : ""
  };

  try {
    const res = await authFetch("/api/user/notify", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("个人通知设置已成功保存！", "success");
      closeModal("user-notify-modal");
    } else {
      showToast(data.error || "保存失败", "error");
    }
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
  }
}

// 9. 实时控制台日志与分类过滤 (双维绝对隔离：平台筛选 + 业务事件)
function switchPlatformFilter(platform) {
  activePlatformFilter = platform;
  const pAll = document.getElementById('tab-platform-all');
  const pCt = document.getElementById('tab-platform-ctyun');
  const pYd = document.getElementById('tab-platform-ydpc');
  if (pAll) pAll.className = platform === 'all' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  if (pCt) pCt.className = platform === 'ctyun' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  if (pYd) pYd.className = platform === 'ydpc' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  renderFilteredLogs();
}

function switchLogFilter(filterType) {
  activeLogFilter = filterType;
  const tTasks = document.getElementById('tab-tasks');
  const tHeart = document.getElementById('tab-heartbeat');
  const tAll = document.getElementById('tab-all');
  if (tTasks) tTasks.className = filterType === 'tasks' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  if (tHeart) tHeart.className = filterType === 'heartbeat' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  if (tAll) tAll.className = filterType === 'all' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  renderFilteredLogs();
}

// 统一日志可见性判定引擎 (双维过滤：平台隔离 + 业务类型)
function shouldDisplayLogItem(item) {
  if (!item) return false;

  // 1. 平台维度绝对隔离
  const isSystemOrAuth = item.source === 'System' || item.source === 'Auth' || item.source === 'Admin' || item.source === 'Notify';
  if (!isSystemOrAuth) {
    if (activePlatformFilter === 'ctyun' && item.platform !== 'ctyun') return false;
    if (activePlatformFilter === 'ydpc' && item.platform !== 'ydpc') return false;
  }

  // 2. 业务事件维度过滤 (心跳/长连保活 vs 业务任务)
  const isHeartbeat = item.source === 'Heartbeat' || item.source === 'CAG' || item.source === 'KeepAlive' || item.source === 'SOHO';
  if (activeLogFilter === 'heartbeat' && !isHeartbeat) return false;
  if (activeLogFilter === 'tasks' && isHeartbeat) return false;
  return true;
}

function createLogLineElement(item) {
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
  return line;
}

function renderFilteredLogs() {
  const logBox = document.getElementById("log-content");
  if (!logBox) return;
  logBox.innerHTML = "";

  const filtered = allReceivedLogs.filter(shouldDisplayLogItem);

  if (filtered.length === 0) {
    logBox.innerHTML = `<div class="log-line" style="color: #64748b; padding: 12px 0; text-align: center;">[暂无此类日志]</div>`;
    return;
  }

  filtered.forEach(item => {
    logBox.appendChild(createLogLineElement(item));
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
      const logBox = document.getElementById("log-content");

      if (item.isUpdate) {
        // 全双工智能折叠：就地更新最后一行，刷新时间戳与徽标 x99
        const idx = allReceivedLogs.findIndex(l => (l.id && l.id === item.id) || (l.source === item.source && l.accountName === item.accountName));
        if (idx !== -1) {
          allReceivedLogs[idx] = item;
        } else {
          allReceivedLogs.push(item);
        }

        if (logBox) {
          const existingLine = item.id ? logBox.querySelector(`[data-log-id="${item.id}"]`) : null;
          if (existingLine) {
            // 如果此条日志不再符合当前过滤条件 (例如在移动云视图收到了天翼云折叠消息)，从 DOM 移除
            if (!shouldDisplayLogItem(item)) {
              existingLine.remove();
            } else {
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
            }
            return;
          }

          // DOM 中尚无该行，且符合当前过滤条件时动态追加
          if (shouldDisplayLogItem(item)) {
            const emptyEl = logBox.querySelector('.log-line');
            if (emptyEl && emptyEl.innerText.includes('[暂无此类日志]')) {
              emptyEl.remove();
            }
            logBox.appendChild(createLogLineElement(item));
            if (autoScroll) logBox.scrollTop = logBox.scrollHeight;
          }
        }
        return;
      }

      allReceivedLogs.push(item);
      if (allReceivedLogs.length > 3000) allReceivedLogs.shift();

      // 实时追加：严格检查是否符合当前平台视图与业务类型过滤规则
      if (logBox && shouldDisplayLogItem(item)) {
        const emptyEl = logBox.querySelector('.log-line');
        if (emptyEl && emptyEl.innerText.includes('[暂无此类日志]')) {
          emptyEl.remove();
        }
        logBox.appendChild(createLogLineElement(item));
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
  
  // 回显头像设置
  if (document.getElementById("custom-user-avatar")) {
    document.getElementById("custom-user-avatar").value = currentUser?.avatar || "";
  }
  updateAvatarPreview(currentUser?.avatar || (currentUser?.username || "A")[0].toUpperCase());

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

function selectPresetAvatar(emoji) {
  const input = document.getElementById("custom-user-avatar");
  if (input) input.value = emoji;
  updateAvatarPreview(emoji);
}

function updateAvatarPreview(text) {
  const preview = document.getElementById("current-avatar-preview");
  if (!preview) return;
  const val = (text || '').trim();
  preview.innerText = val ? val.slice(0, 2) : ((currentUser?.username || "A")[0].toUpperCase());
}

async function submitChangeAvatar() {
  const customAvatar = document.getElementById("custom-user-avatar") ? document.getElementById("custom-user-avatar").value.trim() : "";
  if (!customAvatar) {
    showToast("请输入或选择一个头像内容", "error");
    return;
  }

  try {
    const res = await authFetch("/api/auth/change-avatar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ avatar: customAvatar })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      if (currentUser) currentUser.avatar = customAvatar;
      const headerAvatar = document.getElementById("header-avatar");
      if (headerAvatar) headerAvatar.innerText = customAvatar.slice(0, 2);
      showToast("🎉 头像个性化设置已保存！", "success");
    } else {
      showToast(data.error || "头像设置失败", "error");
    }
  } catch (e) {
    showToast("请求网络异常: " + e.message, "error");
  }
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

// 响应式窗口缩放防抖自动重新排版
let resizeGridTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeGridTimer);
  resizeGridTimer = setTimeout(() => {
    if (currentUser) renderAccounts();
  }, 250);
});

