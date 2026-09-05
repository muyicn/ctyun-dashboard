const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const LightweightOcr = require('./app/lightweight_ocr');
const CtYunEncryption = require('./app/ctyun_encryption');
const { executeRealAiChat, executeRealHang } = require('./app/tasks/real_tasks');
const { AuthManager } = require('./app/auth_manager');
const { TaskScheduler } = require('./app/tasks/scheduler');

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.CTYUN_DATA_DIR || path.join(__dirname, 'data');
const STATIC_DIR = path.join(__dirname, 'app', 'static');
const CONFIG_FILE = path.join(DATA_DIR, 'app_config.json');
const ACCOUNTS_JSON = path.join(DATA_DIR, 'accounts.json');
const DEVICES_DIR = path.join(DATA_DIR, 'devices');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DEVICES_DIR)) fs.mkdirSync(DEVICES_DIR, { recursive: true });

let ocrEngine = null;
try {
  ocrEngine = new LightweightOcr();
  console.log('[*] 极速轻量化原生 ONNX 识别引擎初始化成功 (已彻底剔除 TensorFlow 与 WebAssembly)');
} catch (e) {
  console.error('[!] 轻量 OCR 初始化异常:', e);
}

const logs = [];
const sseClients = new Set();

function getBeijingTimeString() {
  const d = new Date();
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  const bjTime = new Date(utc + (3600000 * 8));
  const Y = bjTime.getFullYear();
  const M = String(bjTime.getMonth() + 1).padStart(2, '0');
  const D = String(bjTime.getDate()).padStart(2, '0');
  const h = String(bjTime.getHours()).padStart(2, '0');
  const m = String(bjTime.getMinutes()).padStart(2, '0');
  const s = String(bjTime.getSeconds()).padStart(2, '0');
  return `${Y}-${M}-${D} ${h}:${m}:${s}`;
}

function getBeijingTimeOnly() {
  const d = new Date();
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  const bjTime = new Date(utc + (3600000 * 8));
  const h = String(bjTime.getHours()).padStart(2, '0');
  const m = String(bjTime.getMinutes()).padStart(2, '0');
  const s = String(bjTime.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function getBeijingDateOnly() {
  const d = new Date();
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  const bjTime = new Date(utc + (3600000 * 8));
  const Y = bjTime.getFullYear();
  const M = String(bjTime.getMonth() + 1).padStart(2, '0');
  const D = String(bjTime.getDate()).padStart(2, '0');
  return `${Y}-${M}-${D}`;
}

function appendLog(source, message, level = 'info', accountName = '') {
  const entry = {
    timestamp: getBeijingTimeString(),
    source,
    message,
    level,
    accountName: accountName || ''
  };
  logs.push(entry);
  if (logs.length > 3000) logs.shift();

  // 推送给具备权限的 SSE 客户端
  for (const client of sseClients) {
    try {
      if (canUserSeeLog(client.session, entry)) {
        client.res.write(`data: ${JSON.stringify(entry)}\n\n`);
      }
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

function canUserSeeLog(session, logEntry) {
  // 未登录完全不可见日志
  if (!session) return false;
  // 管理员可见全局所有日志
  if (session.role === 'admin') return true;
  
  // 普通用户权限严格收敛：只能看到属于自己用户账号的相关日志
  const currentUsername = session.username;

  // 1. 如果是认证或用户操作日志，只有针对该用户自己的日志才展示给该用户
  if (logEntry.source === 'Auth') {
    if (logEntry.message && logEntry.message.includes(`[${currentUsername}]`)) {
      return true;
    }
  }

  // 2. 如果是云电脑任务/心跳日志，必须严格匹配该用户自己名下的云电脑账号名称或手机号
  const ownedAccounts = appConfig.accounts.filter(a => a.ownerId === session.userId);
  const ownedAccNames = ownedAccounts.map(a => a.name).filter(Boolean);
  const ownedAccUsers = ownedAccounts.map(a => a.user).filter(Boolean);
  
  if (logEntry.accountName && (ownedAccNames.includes(logEntry.accountName) || ownedAccUsers.includes(logEntry.accountName))) {
    return true;
  }
  for (const name of ownedAccNames) {
    if (logEntry.message && logEntry.message.includes(`[${name}]`)) return true;
  }
  for (const u of ownedAccUsers) {
    if (logEntry.message && logEntry.message.includes(`[${u}]`)) return true;
  }

  return false;
}

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex').toLowerCase();
}
function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex').toLowerCase();
}

function generateDeviceCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return 'web_' + s;
}

// SSRF 防护：校验 URL 是否为安全的外部公共 HTTP/HTTPS 地址
function isPrivateIpOrHost(hostname) {
  const h = (hostname || '').toLowerCase().trim();
  if (!h) return true;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;

  if (net.isIPv4(h)) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 127) return true; // 127.0.0.0/8 loopback
    if (parts[0] === 10) return true;  // 10.0.0.0/8 private
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12 private
    if (parts[0] === 192 && parts[1] === 168) return true; // 192.168.0.0/16 private
    if (parts[0] === 169 && parts[1] === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
    if (parts[0] === 0) return true;   // 0.0.0.0/8 current network
  }

  if (net.isIPv6(h)) {
    if (h === '::1' || h === '::') return true;
    if (h.startsWith('fe80:')) return true; // link-local
    if (h.startsWith('fc00:') || h.startsWith('fd00:')) return true; // ULA
  }

  return false;
}

function isValidWebhookUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const u = new URL(rawUrl.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (isPrivateIpOrHost(u.hostname)) return false;
    return true;
  } catch (e) {
    return false;
  }
}

// 资源归属权鉴权辅助：确保用户只能管理自己名下的账号，admin 可管理全部
function canUserAccessAccount(session, account) {
  if (!session || !account) return false;
  if (session.role === 'admin') return true;
  return account.ownerId === session.userId;
}

// Webhook 通知服务（支持完全自定义标题与内容模板及参数替换，集成 SSRF 防护）
async function sendNotification(settings, title, content, extraVars = {}) {
  const notify = settings?.notify;
  if (!notify || !notify.enabled) return { success: false, message: '通知未开启' };

  const channel = notify.channel || 'webhook';

  // SSRF 安全防御校验
  if (notify.webhookUrl && !isValidWebhookUrl(notify.webhookUrl)) {
    appendLog('Notify', `[安全拦截] 拒绝向私有/内网或非法协议地址发送 Webhook: ${notify.webhookUrl}`, 'error');
    return { success: false, message: '安全拦截：禁止向内网/本地私有地址或非法协议发送 Webhook' };
  }
  
  // 模板变量替换
  let finalTitle = notify.customTitleTemplate || title;
  let finalContent = notify.customContentTemplate || content;

  const vars = {
    '{title}': title,
    '{content}': content,
    '{time}': new Date().toISOString().replace('T', ' ').substring(0, 19),
    '{account}': extraVars.account || '云电脑',
    '{task}': extraVars.task || '',
    '{status}': extraVars.status || '',
    '{points}': extraVars.points || ''
  };

  for (const [k, v] of Object.entries(vars)) {
    finalTitle = finalTitle.split(k).join(v);
    finalContent = finalContent.split(k).join(v);
  }

  appendLog('Notify', `触发 [${channel}] 推送: ${finalTitle}`, 'info');

  try {
    if (channel === 'webhook' && notify.webhookUrl) {
      const res = await fetch(notify.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: finalTitle, content: finalContent, time: vars['{time}'] })
      });
      return { success: res.ok, message: `HTTP ${res.status}` };
    } else if (channel === 'qywx' && notify.webhookUrl) {
      // 企业微信机器人 Webhook (支持 markdown 格式)
      const qywxPayload = {
        msgtype: 'markdown',
        markdown: {
          content: `### ${finalTitle}\n\n${finalContent}\n\n> 触发时间: ${vars['{time}']}`
        }
      };
      const res = await fetch(notify.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(qywxPayload)
      });
      const qywxData = await res.json().catch(() => ({}));
      return { success: res.ok && qywxData.errcode === 0, message: qywxData.errmsg || `HTTP ${res.status}` };
    } else if (channel === 'serverchan' && notify.webhookUrl) {
      const url = `https://sctapi.ftqq.com/${notify.webhookUrl}.send`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ title: finalTitle, desp: finalContent }).toString()
      });
      return { success: res.ok, message: `HTTP ${res.status}` };
    } else if (channel === 'pushplus' && notify.webhookUrl) {
      const res = await fetch('http://www.pushplus.plus/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: notify.webhookUrl, title: finalTitle, content: finalContent })
      });
      return { success: res.ok, message: `HTTP ${res.status}` };
    } else if (channel === 'bark' && notify.webhookUrl) {
      const base = notify.webhookUrl.replace(/\/+$/, '');
      const res = await fetch(`${base}/${encodeURIComponent(finalTitle)}/${encodeURIComponent(finalContent)}`);
      return { success: res.ok, message: `HTTP ${res.status}` };
    } else if (channel === 'telegram' && notify.webhookUrl) {
      const [botToken, chatId] = notify.webhookUrl.split('@');
      if (botToken && chatId) {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: `*${finalTitle}*\n\n${finalContent}`, parse_mode: 'Markdown' })
        });
        return { success: res.ok, message: `HTTP ${res.status}` };
      }
    }
  } catch (err) {
    appendLog('Notify', `通知发送异常: ${err.message}`, 'error');
    return { success: false, message: err.message };
  }
  return { success: false, message: '未配置推送目标或通道无效' };
}

// AES-256-GCM 密码强加密与安全落盘
const MASTER_KEY_FILE = path.join(DATA_DIR, '.master.key');

function getOrCreateMasterKey() {
  if (fs.existsSync(MASTER_KEY_FILE)) {
    try {
      const raw = fs.readFileSync(MASTER_KEY_FILE, 'utf8').trim();
      if (raw.length === 64) {
        return Buffer.from(raw, 'hex');
      }
    } catch (e) {}
  }
  const newKey = crypto.randomBytes(32);
  try {
    fs.writeFileSync(MASTER_KEY_FILE, newKey.toString('hex'), { mode: 0o600 });
  } catch (e) {}
  return newKey;
}

const masterKey = getOrCreateMasterKey();

function encryptPassword(plainText) {
  if (!plainText || typeof plainText !== 'string') return '';
  if (plainText.startsWith('ENC:')) return plainText; // 避免重复加密
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
    let enc = cipher.update(plainText, 'utf8', 'hex');
    enc += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return 'ENC:' + iv.toString('hex') + ':' + authTag + ':' + enc;
  } catch (e) {
    return plainText;
  }
}

function decryptPassword(cipherText) {
  if (!cipherText || typeof cipherText !== 'string') return '';
  if (!cipherText.startsWith('ENC:')) return cipherText; // 兼容历史明文
  try {
    const parts = cipherText.split(':');
    if (parts.length !== 4) return cipherText;
    const iv = Buffer.from(parts[1], 'hex');
    const authTag = Buffer.from(parts[2], 'hex');
    const encrypted = parts[3];
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
    decipher.setAuthTag(authTag);
    let dec = decipher.update(encrypted, 'hex', 'utf8');
    dec += decipher.final('utf8');
    return dec;
  } catch (e) {
    return cipherText;
  }
}

function getDefaultConfig() {
  return {
    version: '1.0.0',
    settings: {
      webPort: PORT,
      keepAliveSeconds: 60,
      allowRegistration: false, // 默认不开放注册，必须由管理员后台手动开启
      defaultQuota: 2,         // 普通用户默认配额 2 台
      cron: {
        signCron: '0 2 * * *',
        aiChatCron: '0 3,20 * * *',
        cloudHangCron: '0 4,6 * * *',
        redeemCron: '0 7 * * *'
      },
      notify: {
        enabled: false,
        channel: 'webhook',
        webhookUrl: ''
      }
    },
    users: [],
    accounts: []
  };
}

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const content = fs.readFileSync(CONFIG_FILE, 'utf8');
      const cfg = JSON.parse(content);
      if (!cfg.settings) cfg.settings = getDefaultConfig().settings;
      if (!cfg.accounts) cfg.accounts = [];
      if (!cfg.users) cfg.users = [];
      // 默认已有账号归属 admin，并解密密码还原至内存
      cfg.accounts.forEach(a => {
        if (!a.ownerId) a.ownerId = 'u_admin';
        if (a.password) a.password = decryptPassword(a.password);
      });
      return cfg;
    } catch (e) {
      console.error('读取配置失败:', e);
    }
  }
  const defaultCfg = getDefaultConfig();
  saveConfig(defaultCfg);
  return defaultCfg;
}

function saveConfig(cfg) {
  try {
    const configToSave = cfg || appConfig;
    
    // 安全深拷贝用于加密落盘，内存中的密码仍然由各功能使用
    const diskClone = JSON.parse(JSON.stringify(configToSave));
    if (Array.isArray(diskClone.accounts)) {
      for (const a of diskClone.accounts) {
        if (a.password) {
          a.password = encryptPassword(a.password);
        }
      }
    }

    fs.writeFileSync(CONFIG_FILE, JSON.stringify(diskClone, null, 2), 'utf8');

    // accounts.json 同样加密保护
    const active = (configToSave.accounts || [])
      .filter(a => a.enabled !== false && a.features?.keepAlive !== false)
      .map(a => ({
        name: a.name || a.user,
        user: a.user,
        password: encryptPassword(a.password),
        deviceCode: a.deviceCode
      }));
    const ctyunJson = {
      keepAliveSeconds: configToSave.settings?.keepAliveSeconds || 60,
      accounts: active
    };
    fs.writeFileSync(ACCOUNTS_JSON, JSON.stringify(ctyunJson, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('保存配置失败:', e);
    return false;
  }
}

let appConfig = loadConfig();

// 初始化多用户管理器
const authManager = new AuthManager({
  get config() { return appConfig; },
  saveConfig: () => saveConfig(appConfig)
});

// ==========================================================
// 生产级天翼云原生客户端（严格实现 CtYun C# 原生保活心跳与协议）
// ==========================================================
class CtYunClient {
  constructor(account) {
    this.account = account;
    this.version = '103020001';
    this.deviceType = '60';
    this.loginInfo = null;
    this.ws = null;
    this.wsAlive = false;
    this.encryptor = new CtYunEncryption();
    
    this.metrics = {
      status: 'offline',
      currentHost: '',
      desktopName: '',
      keepAliveSeconds: appConfig.settings?.keepAliveSeconds || 60,
      cycleCountdown: 60,
      lastHeartbeatTime: '',
      lastHeartbeatResult: '未建立连接',
      successCount: 0,
      errorCount: 0,
      officialTasks: [],
      userPoints: 0
    };

    this.workerRunning = false;
    this.loopTimer = null;
    this.countdownTimer = null;
  }

  async getCaptchaCode(user) {
    if (!ocrEngine) ocrEngine = new DdddOcr();
    const capUrl = `https://desk.ctyun.cn:8810/api/auth/client/captcha?height=36&width=85&userInfo=${user}&mode=auto&_t=${Date.now()}`;
    const res = await fetch(capUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0',
        'ctg-devicetype': this.deviceType,
        'ctg-version': this.version,
        'ctg-devicecode': this.account.deviceCode,
        'referer': 'https://pc.ctyun.cn/'
      }
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const code = await ocrEngine.classification(buf);
    return (code || '').trim();
  }

  async login(maxRetries = 4) {
    const user = this.account.user;
    const password = this.account.password;
    const deviceCode = this.account.deviceCode;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const chalRes = await fetch('https://desk.ctyun.cn:8810/api/auth/client/genChallengeData', {
          method: 'POST',
          headers: {
            'ctg-devicetype': this.deviceType,
            'ctg-version': this.version,
            'ctg-devicecode': deviceCode,
            'Content-Type': 'application/json'
          },
          body: '{}'
        });
        const chalData = await chalRes.json();
        if (chalData.code !== 0) throw new Error(chalData.msg || '获取验证码挑战失败');

        const { challengeCode, challengeId } = chalData.data;
        const captchaCode = await this.getCaptchaCode(user);

        const body = new URLSearchParams({
          userAccount: user,
          password: sha256(password + challengeCode),
          sha256Password: sha256(sha256(password) + challengeCode),
          challengeId,
          captchaCode,
          deviceCode,
          deviceName: 'Chrome浏览器',
          deviceType: this.deviceType,
          deviceModel: 'Windows NT 10.0; Win64; x64',
          appVersion: '3.2.0',
          sysVersion: 'Windows NT 10.0; Win64; x64',
          clientVersion: this.version
        });

        const loginRes = await fetch('https://desk.ctyun.cn:8810/api/auth/client/login', {
          method: 'POST',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0',
            'ctg-devicetype': this.deviceType,
            'ctg-version': this.version,
            'ctg-devicecode': deviceCode,
            'referer': 'https://pc.ctyun.cn/',
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: body.toString()
        });

        const result = await loginRes.json();
        if (result.code === 0 && result.data) {
          this.loginInfo = result.data;
          this.account.bound = !!result.data.bondedDevice;
          return { success: true, data: result.data };
        }

        if (result.msg && (result.msg.includes('用户名或密码错误') || result.code === 51040)) {
          return { success: false, error: '用户名或密码错误，请检查账号密码！' };
        }

        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 800));
        }
      } catch (err) {
        if (attempt === maxRetries) return { success: false, error: err.message };
      }
    }
    return { success: false, error: '天翼云登录超时，请稍后重试' };
  }

  getSignedHeaders(customHeaders = {}) {
    if (!this.loginInfo) return {};
    const timestamp = Date.now().toString();
    const str = `${this.deviceType}${timestamp}${this.loginInfo.tenantId}${timestamp}${this.loginInfo.userId}${this.version}${this.loginInfo.secretKey}`;
    const sig = md5(str);
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0',
      'ctg-devicetype': this.deviceType,
      'ctg-version': this.version,
      'ctg-devicecode': this.account.deviceCode,
      'ctg-userid': this.loginInfo.userId.toString(),
      'ctg-tenantid': this.loginInfo.tenantId.toString(),
      'ctg-timestamp': timestamp,
      'ctg-requestid': timestamp,
      'ctg-signaturestr': sig,
      'referer': 'https://pc.ctyun.cn/',
      ...customHeaders
    };
  }

  async getDesktops() {
    if (!this.loginInfo) {
      const logRes = await this.login();
      if (!logRes.success) throw new Error(logRes.error);
    }
    const res = await fetch('https://desk.ctyun.cn:8810/api/desktop/client/pageDesktop', {
      method: 'POST',
      headers: this.getSignedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        getCnt: 20,
        desktopTypes: ['1', '2001', '2002', '2003'],
        sortType: 'createTimeV1'
      })
    });
    const json = await res.json();
    return json.code === 0 && json.data ? json.data.desktopList || [] : [];
  }

  async connect(desktopId, vdCommand = '') {
    if (!this.loginInfo) {
      const logRes = await this.login();
      if (!logRes.success) throw new Error(logRes.error);
    }
    const connBody = new URLSearchParams({
      objId: desktopId,
      objType: '0',
      osType: '15',
      deviceId: this.deviceType,
      vdCommand: vdCommand || '',
      ipAddress: '',
      macAddress: '',
      deviceCode: this.account.deviceCode,
      deviceName: 'Chrome浏览器',
      deviceType: this.deviceType,
      deviceModel: 'Windows NT 10.0; Win64; x64',
      appVersion: '3.2.0',
      sysVersion: 'Windows NT 10.0; Win64; x64',
      clientVersion: this.version
    });

    const res = await fetch('https://desk.ctyun.cn:8810/api/desktop/client/connect', {
      method: 'POST',
      headers: this.getSignedHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: connBody.toString()
    });
    const json = await res.json();
    if (json.code === 0) {
      return json.data?.desktopInfo || json.data;
    }
    throw new Error(json.msg || '获取云电脑连接配置失败');
  }

  // 云电脑电源管理操作 (开机: start / 重启: reboot / 关机: shutdown)
  async controlPower(desktopId, action) {
    const accName = this.account.name || this.account.user;
    appendLog('System', `[${accName}] 正在下发云电脑电源指令: ${action} ...`, 'info');
    
    // 天翼云标准电源指令映射
    const cmdMap = {
      'poweron': 'start',
      'start': 'start',
      'reboot': 'reboot',
      'restart': 'reboot',
      'shutdown': 'shutdown',
      'poweroff': 'shutdown'
    };
    const finalCmd = cmdMap[action.toLowerCase()] || action;

    try {
      await this.connect(desktopId, finalCmd);
      appendLog('System', `[${accName}] ✅ 云电脑【${action}】指令已成功下达天翼云网关`, 'success');
      return { success: true, message: `指令【${action}】已成功下达！` };
    } catch (e) {
      appendLog('System', `[${accName}] ❌ 下发电源指令失败: ${e.message}`, 'error');
      return { success: false, error: e.message };
    }
  }

  // 智能关机检测与自动开机等待保活保障
  async ensureDesktopRunning(desktop) {
    const desktopId = desktop.objId || desktop.desktopId;
    const accName = this.account.name || this.account.user;

    const isRunning = desktop.useStatusText === '运行中' || desktop.status === 'OK';
    if (isRunning) return true;

    appendLog('KeepAlive', `[${accName}][${desktop.objName || desktopId}] ⚠️ 检测到云电脑处于 [${desktop.useStatusText || '已关机'}] 状态，正在唤醒开机...`, 'warning');
    sendNotification(
      appConfig.settings,
      `⚠️ 云电脑离线开机唤醒 - ${accName}`,
      `云电脑当前处于 [${desktop.useStatusText || '已关机'}] 状态，守护系统已下发开机指令，正在等待云电脑就绪...`
    );

    try {
      await this.connect(desktopId);
    } catch (e) {}

    const startTime = Date.now();
    while (Date.now() - startTime < 180000) {
      await new Promise(r => setTimeout(r, 6000));
      const list = await this.getDesktops();
      const cur = list.find(d => (d.objId || d.desktopId) === desktopId);
      if (cur && (cur.useStatusText === '运行中' || cur.status === 'OK')) {
        appendLog('KeepAlive', `[${accName}][${desktop.objName || desktopId}] 🎉 云电脑已开机就绪！建立保活长连接`, 'success');
        sendNotification(
          appConfig.settings,
          `✅ 云电脑开机成功 - ${accName}`,
          `云电脑已成功开机进入 [运行中] 状态，长连接心跳保活已建立。`
        );
        return true;
      }
      appendLog('KeepAlive', `[${accName}] 正在等待开机就绪 (${Math.floor((Date.now() - startTime) / 1000)}s / 180s)...`, 'info');
    }

    appendLog('KeepAlive', `[${accName}] 云电脑开机唤醒超时 (180s)，将在下一周期继续尝试`, 'error');
    return false;
  }

  async refreshOfficialTasks() {
    if (!this.loginInfo) await this.login();
    if (!this.loginInfo) return;

    try {
      const taskRes = await (await fetch('https://desk.ctyun.cn/selforder/api/marketing/userPoints/getTaskList', {
        headers: this.getSignedHeaders()
      })).json();

      if (taskRes.code === 0 && taskRes.data) {
        this.metrics.officialTasks = taskRes.data.map(t => ({
          name: t.taskDefName,
          current: t.currentProgress || 0,
          total: t.totalProgress || 1,
          status: t.status,
          points: t.pointsList?.[0]?.value || 100
        }));

        const hangTask = this.metrics.officialTasks.find(t => t.name.includes('使用1小时'));
        if (hangTask) {
          this.account.stats.hangMinutesToday = Math.floor(hangTask.current / 60);
        }

        // 核心联动：如果官方“登录AI云电脑”任务状态为已完成 (status === 2 或 current >= total)，自动同步今日已签到
        const loginTask = this.metrics.officialTasks.find(t => t.name.includes('登录AI云电脑'));
        if (loginTask && (loginTask.status === 2 || loginTask.current >= loginTask.total)) {
          if (!this.account.stats.lastSignTime || !this.account.stats.lastSignTime.startsWith(getBeijingDateOnly())) {
            this.account.stats.lastSignTime = getBeijingTimeString();
          }
        }
      }

      const pointRes = await (await fetch('https://desk.ctyun.cn/selforder/api/marketing/userPoints/getUserPoints', {
        headers: this.getSignedHeaders()
      })).json();

      if (pointRes.code === 0 && Array.isArray(pointRes.data) && pointRes.data.length > 0) {
        // 核心修复：pointRes.data 数组可能包含两项，一项为 willOutDate: true 即将过期的子积分（如100分），一项为真实总积分（如900分）
        // 优先精准提取非即将过期（willOutDate != true）的主账户可用总积分项；若都无标识则取数值最大项！
        const validItem = pointRes.data.find(p => !p.willOutDate && p.pointType === 1) || 
                          pointRes.data.reduce((max, cur) => ((cur.points || 0) > (max.points || 0) ? cur : max), pointRes.data[0]);
        this.metrics.userPoints = validItem ? (validItem.points || 0) : 0;
        this.account.stats.points = this.metrics.userPoints;
      }

      saveConfig(appConfig);
    } catch (e) {}
  }

  async getRewards() {
    if (!this.loginInfo) await this.login();
    const res = await fetch('https://desk.ctyun.cn/selforder/api/selforder/prod/get?prodId=17000000&prodCode=POINTS', {
      headers: this.getSignedHeaders()
    });
    const data = await res.json();
    const rewards = [];
    if (data && data.data) {
      for (const mall of data.data) {
        for (const series of (mall.series || [])) {
          for (const sku of (series.sku || [])) {
            rewards.push({
              prodId: sku.prodId,
              prodName: sku.prodName,
              costPoints: sku.costPoints,
              prodType: sku.prodType,
              description: (sku.description || series.description || '').replace(/<[^>]+>/g, ' ')
            });
          }
        }
      }
    }
    return rewards;
  }

  startKeepAliveWorker() {
    if (this.workerRunning) return;
    this.workerRunning = true;
    this.runCycleLoop();
  }

  stopKeepAliveWorker() {
    this.workerRunning = false;
    if (this.loopTimer) clearTimeout(this.loopTimer);
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
    }
    this.wsAlive = false;
    this.metrics.status = 'offline';
  }

  async runCycleLoop() {
    const accName = this.account.name || this.account.user;

    while (this.workerRunning) {
      try {
        const keepSeconds = appConfig.settings?.keepAliveSeconds || 60;
        this.metrics.keepAliveSeconds = keepSeconds;
        appendLog('Heartbeat', `[${accName}] === 新保活周期开始 (设定保持: ${keepSeconds}秒) ===`, 'info');
        
        const desktops = await this.getDesktops();
        if (!desktops || desktops.length === 0) {
          appendLog('KeepAlive', `[${accName}] 账号名下暂无可用云电脑，60秒后重试...`, 'warning');
          this.metrics.status = 'offline';
          this.metrics.lastHeartbeatResult = '名下无云电脑';
          await new Promise(r => setTimeout(r, 60000));
          continue;
        }

        const desktop = desktops[0];
        const desktopId = desktop.objId || desktop.desktopId;
        this.metrics.desktopName = desktop.objName || desktop.desktopName || '云电脑';

        // 确保云电脑已处于运行中，若关机则先唤醒开机！
        const isReady = await this.ensureDesktopRunning(desktop);
        if (!isReady) {
          await new Promise(r => setTimeout(r, 30000));
          continue;
        }

        const desktopInfo = await this.connect(desktopId);
        this.metrics.currentHost = desktopInfo.clinkLvsOutHost;
        const wsUrl = `wss://${desktopInfo.clinkLvsOutHost}/clinkProxy/${desktopId}/MAIN`;

        await new Promise((resolveSession) => {
          let cycleDone = false;
          let sessionTimeout = null;

          const endSession = (reason) => {
            if (cycleDone) return;
            cycleDone = true;
            if (sessionTimeout) clearTimeout(sessionTimeout);
            if (this.countdownTimer) clearInterval(this.countdownTimer);
            if (this.ws) {
              try { this.ws.close(); } catch (e) {}
            }
            this.wsAlive = false;
            resolveSession();
          };

          this.resetCycleTimeout = (newSeconds) => {
            if (cycleDone) return;
            if (sessionTimeout) clearTimeout(sessionTimeout);
            this.metrics.keepAliveSeconds = newSeconds;
            this.metrics.cycleCountdown = newSeconds;
            sessionTimeout = setTimeout(() => {
              appendLog('Heartbeat', `[${accName}][${this.metrics.desktopName}] 周期时间到 (${newSeconds}s)，强制重连刷新天翼云会话...`, 'info');
              endSession('Timeout Reset');
            }, newSeconds * 1000);
          };

          sessionTimeout = setTimeout(() => {
            appendLog('Heartbeat', `[${accName}][${this.metrics.desktopName}] 周期时间到 (${keepSeconds}s)，强制重连刷新天翼云会话...`, 'info');
            endSession('Timeout Reset');
          }, keepSeconds * 1000);

          this.metrics.cycleCountdown = keepSeconds;
          if (this.countdownTimer) clearInterval(this.countdownTimer);
          this.countdownTimer = setInterval(() => {
            if (this.metrics.cycleCountdown > 0) {
              this.metrics.cycleCountdown--;
            }
          }, 1000);

          this.ws = new WebSocket(wsUrl, ['binary'], {
            headers: { 'Origin': 'https://pc.ctyun.cn' }
          });
          this.ws.binaryType = 'arraybuffer';

          this.ws.onopen = () => {
            this.wsAlive = true;
            this.metrics.status = 'online';
            this.metrics.successCount++;
            this.account.stats.keepAliveStatus = 'online';
            saveConfig(appConfig);

            appendLog('Heartbeat', `[${accName}][${this.metrics.desktopName}] 🟢 保活长连接就绪 (${this.metrics.currentHost})`, 'success');

            const hostParts = (desktopInfo.clinkLvsOutHost || '').split(':');
            const connectMsg = {
              type: 1,
              ssl: 1,
              host: hostParts[0],
              port: hostParts[1] || '443',
              ca: desktopInfo.caCert,
              cert: desktopInfo.clientCert,
              key: desktopInfo.clientKey,
              servername: desktopInfo.host + ':' + desktopInfo.port,
              oqs: 0
            };
            this.ws.send(JSON.stringify(connectMsg));

            setTimeout(() => {
              if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                const initBuf = Buffer.from('UkVEUQIAAAACAAAAGgAAAAAAAAABAAEAAAABAAAAEgAAAAkAAAAECAAA', 'base64');
                this.ws.send(initBuf);
                appendLog('Heartbeat', `[${accName}] 已发送保活特征码报文 (UkVEUQIA...)`, 'info');
              }
            }, 500);
          };

          this.ws.onmessage = (evt) => {
            try {
              const buf = Buffer.from(evt.data);
              const hex = buf.toString('hex').toUpperCase();

              if (hex.startsWith('52454451')) {
                const nowStr = getBeijingTimeOnly();
                appendLog('Heartbeat', `[${accName}][${this.metrics.desktopName}] 收到服务端保活校验 REDQ (${buf.length}B)`, 'info');

                const responseBuf = this.encryptor.execute(buf);
                this.ws.send(responseBuf);

                this.metrics.lastHeartbeatTime = nowStr;
                this.metrics.lastHeartbeatResult = `REDQ 校验成功，已回传 ${responseBuf.length} 字节加密应答 (${nowStr})`;
                appendLog('Heartbeat', `[${accName}][${this.metrics.desktopName}] -> ✅ 成功回传 RSA-OAEP 加密应答 (${responseBuf.length}B)`, 'success');
                return;
              }

              if (buf.length >= 6) {
                const type = buf.readUInt16LE(0);
                if (type === 103) {
                  appendLog('Heartbeat', `[${accName}] 收到云电脑 103 认证，正在上报 118 用户身份...`, 'info');
                  const userPayload = Buffer.from(JSON.stringify({
                    type: 1,
                    userName: this.loginInfo.userName,
                    userInfo: '',
                    userId: this.loginInfo.userId
                  }));

                  const sendBuf = Buffer.alloc(2 + 4 + 8 + userPayload.length);
                  sendBuf.writeUInt16LE(118, 0);
                  sendBuf.writeInt32LE(8 + userPayload.length, 2);
                  sendBuf.writeUInt32LE(userPayload.length, 6);
                  sendBuf.writeUInt32LE(8, 10);
                  userPayload.copy(sendBuf, 14);

                  this.ws.send(sendBuf);
                  appendLog('Heartbeat', `[${accName}] -> ✅ 已回传 118 身份 (用户ID: ${this.loginInfo.userId})，在线状态已激活！`, 'success');
                }
              }
            } catch (err) {
              appendLog('Heartbeat', `[${accName}] 解析报文异常: ${err.message}`, 'warning');
            }
          };

          this.ws.onerror = (err) => {
            appendLog('Heartbeat', `[${accName}] 通道异常: ${err.message || '连接受阻'}`, 'error');
            this.metrics.errorCount++;
            endSession('Socket Error');
          };

          this.ws.onclose = () => {
            endSession('Socket Closed');
          };
        });

        await this.refreshOfficialTasks();
        await new Promise(r => setTimeout(r, 2000));

      } catch (err) {
        appendLog('KeepAlive', `[${accName}] 保活异常: ${err.message}，10秒后重试...`, 'error');
        this.metrics.status = 'offline';
        this.metrics.lastHeartbeatResult = `异常: ${err.message}`;
        this.account.stats.keepAliveStatus = 'offline';
        saveConfig(appConfig);

        sendNotification(
          appConfig.settings,
          `⚠️ 天翼云保活中断告警 - ${accName}`,
          `账号 [${accName}] 的云电脑长连接中断: ${err.message}，守护程序正在自动拉起重试。`
        );

        await new Promise(r => setTimeout(r, 10000));
      }
    }
  }
}

const clientInstances = new Map();

function getClient(acc) {
  if (!clientInstances.has(acc.id)) {
    const client = new CtYunClient(acc);
    // 立即执行一次官方任务与积分的精准拉取
    client.refreshOfficialTasks().catch(() => {});
    clientInstances.set(acc.id, client);
  }
  return clientInstances.get(acc.id);
}

function initAllKeepAlive() {
  for (const acc of appConfig.accounts) {
    if (acc.enabled && acc.features?.keepAlive !== false) {
      const client = getClient(acc);
      client.startKeepAliveWorker();
    }
  }
}

setTimeout(initAllKeepAlive, 2000);

// 初始化定时任务调度中心
const taskScheduler = new TaskScheduler({
  getAccounts: () => appConfig.accounts,
  getSettings: () => appConfig.settings,
  getClient: (acc) => getClient(acc),
  ocrEngine,
  appendLog: (src, msg, lvl) => appendLog(src, msg, lvl),
  sendNotification: (settings, title, content) => sendNotification(settings, title, content)
});
setTimeout(() => taskScheduler.start(), 3000);

// ==========================================================
// HTTP 路由与 API 服务
// ==========================================================
function jsonResponse(res, data, statusCode = 200) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  });
  res.end(JSON.stringify(data));
}

function serveStatic(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('File Not Found');
    } else {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache'
      });
      res.end(data);
    }
  });
}

function parseJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (e) {
        resolve({});
      }
    });
  });
}

function getSessionFromReq(req, parsedUrl = null) {
  const authHeader = req.headers['authorization'] || '';
  let token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token && parsedUrl) {
    token = parsedUrl.searchParams.get('token') || '';
  }
  if (!token && req.headers.cookie) {
    const m = req.headers.cookie.match(/(?:^|;\s*)token=([^;]+)/);
    if (m) token = decodeURIComponent(m[1]);
  }
  const session = authManager.verifySession(token);
  return session;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    });
    res.end();
    return;
  }

  // 1. 静态资源
  if (pathname === '/' || pathname === '/index.html') {
    serveStatic(res, path.join(STATIC_DIR, 'index.html'), 'text/html; charset=utf-8');
    return;
  }
  if (pathname.startsWith('/static/')) {
    const rel = pathname.substring(8);
    const file = path.join(STATIC_DIR, rel);
    let type = 'text/plain';
    if (rel.endsWith('.css')) type = 'text/css; charset=utf-8';
    else if (rel.endsWith('.js')) type = 'application/javascript; charset=utf-8';
    else if (rel.endsWith('.html')) type = 'text/html; charset=utf-8';
    serveStatic(res, file, type);
    return;
  }

  // 2. 实时日志 SSE 流与历史日志获取 (权限严格隔离：未登录完全不可看，普通用户仅看自己账号)
  if (pathname === '/api/logs' && req.method === 'GET') {
    const session = getSessionFromReq(req, parsedUrl);
    if (!session) {
      jsonResponse(res, []);
      return;
    }
    const filtered = logs.filter(l => canUserSeeLog(session, l)).slice(-100);
    jsonResponse(res, filtered);
    return;
  }

  if (pathname === '/api/logs/stream') {
    const session = getSessionFromReq(req, parsedUrl);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Unauthorized');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*'
    });
    // 立即下发初始心跳
    res.write(': connected\n\n');

    const recent = logs.filter(l => canUserSeeLog(session, l)).slice(-80);
    for (const log of recent) {
      res.write(`data: ${JSON.stringify(log)}\n\n`);
    }
    const clientObj = { res, session };
    sseClients.add(clientObj);

    // 每 15 秒主动下发一次 SSE 注释保持活跃，防止浏览器因静默判定连接超时
    const pingTimer = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (e) {
        clearInterval(pingTimer);
        sseClients.delete(clientObj);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(pingTimer);
      sseClients.delete(clientObj);
    });
    return;
  }

  // 3. 用户系统 (登录、注册、修改个人密码、当前用户状态)
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const body = await parseJsonBody(req);
    const result = authManager.login(body.username, body.password);
    if (result.success) {
      appendLog('Auth', `用户 [${body.username}] 登录成功`, 'info');
      jsonResponse(res, result);
    } else {
      jsonResponse(res, result, 400);
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/register') {
    const body = await parseJsonBody(req);
    const result = authManager.register(body.username, body.password);
    if (result.success) {
      appendLog('Auth', `新用户 [${body.username}] 注册成功 (默认配额: ${result.user.maxQuota}台)`, 'success');
      jsonResponse(res, result, 201);
    } else {
      jsonResponse(res, result, 400);
    }
    return;
  }

  // 个人修改密码
  if (req.method === 'POST' && pathname === '/api/auth/change-password') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未登录' }, 401);
      return;
    }
    const body = await parseJsonBody(req);
    const newPwd = (body.newPassword || '').trim();
    if (!newPwd || newPwd.length < 5) {
      jsonResponse(res, { error: '新密码长度至少5位' }, 400);
      return;
    }
    authManager.updateUserPassword(session.userId, newPwd);
    appendLog('Auth', `用户 [${session.username}] 修改了自己的登录密码`, 'info');
    jsonResponse(res, { success: true, message: '密码修改成功' });
    return;
  }

  // 管理员修改自身用户名
  if (req.method === 'POST' && pathname === '/api/auth/change-username') {
    const session = getSessionFromReq(req);
    if (!session || session.role !== 'admin') {
      jsonResponse(res, { error: '权限不足：仅管理员可修改用户名' }, 403);
      return;
    }
    const body = await parseJsonBody(req);
    const newUsername = (body.newUsername || '').trim();
    const updateRes = authManager.updateAdminUsername(session.username, newUsername);
    if (updateRes.success) {
      appendLog('Auth', `管理员用户名已从 [${session.username}] 修改为 [${newUsername}]`, 'warning');
      jsonResponse(res, updateRes);
    } else {
      jsonResponse(res, updateRes, 400);
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const session = getSessionFromReq(req);
    if (session) {
      const user = authManager.getUserById(session.userId);
      const accountsCount = appConfig.accounts.filter(a => a.ownerId === session.userId).length;
      jsonResponse(res, {
        isLoggedIn: true,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          maxQuota: user.maxQuota,
          accountsCount
        }
      });
    } else {
      // 默认提供全局未登录或 admin 访客视图
      jsonResponse(res, {
        isLoggedIn: false,
        allowRegistration: appConfig.settings?.allowRegistration === true,
        defaultQuota: appConfig.settings?.defaultQuota || 2
      });
    }
    return;
  }

  // 5. 管理员用户管理 API
  if (pathname.startsWith('/api/admin/users')) {
    const session = getSessionFromReq(req);
    // 严格鉴权：未登录返回 401，非管理员返回 403
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }
    if (session.role !== 'admin') {
      jsonResponse(res, { error: '权限不足：仅管理员可访问' }, 403);
      return;
    }

    if (req.method === 'GET') {
      jsonResponse(res, authManager.getUsers());
      return;
    }

    if (req.method === 'PUT' && pathname.includes('/quota')) {
      const userId = pathname.split('/')[4];
      const body = await parseJsonBody(req);
      const ok = authManager.updateUserQuota(userId, body.maxQuota);
      if (ok) {
        appendLog('Admin', `管理员调整了用户 [${userId}] 的云电脑添加配额为 ${body.maxQuota} 台`, 'info');
        jsonResponse(res, { success: true });
      } else {
        jsonResponse(res, { error: '用户不存在' }, 404);
      }
      return;
    }

    // 管理员重置或修改任意用户密码
    if (req.method === 'PUT' && pathname.includes('/password')) {
      const userId = pathname.split('/')[4];
      const body = await parseJsonBody(req);
      const newPwd = (body.newPassword || '').trim();
      if (!newPwd || newPwd.length < 5) {
        jsonResponse(res, { error: '新密码长度至少5位' }, 400);
        return;
      }
      const ok = authManager.updateUserPassword(userId, newPwd);
      if (ok) {
        appendLog('Admin', `管理员修改了用户 [${userId}] 的登录密码`, 'warning');
        jsonResponse(res, { success: true, message: '用户密码已更新' });
      } else {
        jsonResponse(res, { error: '用户不存在' }, 404);
      }
      return;
    }

    if (req.method === 'DELETE') {
      const userId = pathname.split('/')[4];
      const ok = authManager.deleteUser(userId);
      if (ok) {
        appendLog('Admin', `管理员删除了用户: ${userId}`, 'warning');
        jsonResponse(res, { success: true });
      } else {
        jsonResponse(res, { error: '删除失败或不允许删除管理员' }, 400);
      }
      return;
    }
  }

  // 6. 统计状态
  if (req.method === 'GET' && pathname === '/api/status') {
    const session = getSessionFromReq(req);
    // 未登录访客不暴露账号统计数据
    if (!session) {
      jsonResponse(res, {
        accountsTotal: 0,
        onlineKeepAlive: 0,
        signedToday: 0,
        currentTime: new Date().toISOString().replace('T', ' ').substring(0, 19),
        isGuest: true
      });
      return;
    }

    let visibleAccounts = appConfig.accounts;
    if (session.role !== 'admin') {
      visibleAccounts = appConfig.accounts.filter(a => a.ownerId === session.userId);
    }
    const total = visibleAccounts.length;
    const online = visibleAccounts.filter(a => a.stats?.keepAliveStatus === 'online').length;
    const today = getBeijingDateOnly();
    const signed = visibleAccounts.filter(a => a.stats?.lastSignTime && a.stats.lastSignTime.startsWith(today)).length;
    // 汇总该用户可见账号的今日已获得总积分 (按今日任务实际完成积分累加，上限每个账号 300 积分)
    let totalTodayEarned = 0;
    const pointsDetails = [];

    for (const a of visibleAccounts) {
      const client = clientInstances.get(a.id);
      const tasks = client?.metrics?.officialTasks || [];
      let accTodayPoints = 0;
      const completedTasks = [];

      for (const t of tasks) {
        if (t.status === 2 || (t.total > 0 && t.current >= t.total)) {
          const val = t.points || 100;
          accTodayPoints += val;
          completedTasks.push({ name: t.name, points: val });
        } else {
          completedTasks.push({ name: t.name, points: 0, progress: `${t.current}/${t.total}` });
        }
      }

      totalTodayEarned += accTodayPoints;
      pointsDetails.push({
        accountId: a.id,
        accountName: a.name || a.user,
        todayPoints: accTodayPoints,
        totalPoints: (client && client.metrics.userPoints) ? client.metrics.userPoints : (a.stats?.points || 0),
        tasks: completedTasks
      });
    }

    jsonResponse(res, {
      accountsTotal: total,
      onlineKeepAlive: online,
      signedToday: signed,
      totalEarnedPoints: totalTodayEarned,
      pointsDetails: pointsDetails,
      currentTime: getBeijingTimeString(),
      isGuest: false
    });
    return;
  }

  // 7. 账号列表（按多用户权限隔离过滤 + 附加实时运行态指标）
  if (req.method === 'GET' && pathname === '/api/accounts') {
    const session = getSessionFromReq(req);
    // 未登录访客直接返回空列表，禁止窥探任何云电脑信息！
    if (!session) {
      jsonResponse(res, []);
      return;
    }

    appConfig = loadConfig();
    let userAccounts = appConfig.accounts;
    if (session.role !== 'admin') {
      // 普通注册用户只能看属于自己的云电脑
      userAccounts = appConfig.accounts.filter(a => a.ownerId === session.userId);
    }

    const enriched = userAccounts.map(acc => {
      const client = getClient(acc);
      return {
        ...acc,
        liveMetrics: client.metrics
      };
    });
    jsonResponse(res, enriched);
    return;
  }

  // 8. 添加账号（包含：必须登录 + 强配额限制 + 真实登录校验）
  if (req.method === 'POST' && pathname === '/api/accounts') {
    const session = getSessionFromReq(req);
    // 未登录访客严禁添加云电脑！
    if (!session) {
      jsonResponse(res, { error: '未授权：请先登录或注册账号后再添加云电脑！' }, 401);
      return;
    }

    const currentOwnerId = session.userId;
    const currentUser = authManager.getUserById(currentOwnerId);

    // 配额限制判断：普通用户受配额上限约束，管理员无限制
    if (currentUser && currentUser.role !== 'admin') {
      const currentOwned = appConfig.accounts.filter(a => a.ownerId === currentOwnerId).length;
      const userMax = currentUser.maxQuota || 2;
      if (currentOwned >= userMax) {
        jsonResponse(res, {
          error: `已达到云电脑添加配额上限（当前配额: ${userMax}台），无法继续添加！请联系管理员提高配额。`
        }, 400);
        return;
      }
    }

    const body = await parseJsonBody(req);
    const user = (body.user || '').trim();
    const pwd = (body.password || '').trim();
    const name = (body.name || user).trim();
    const devCode = (body.deviceCode || '').trim() || generateDeviceCode();

    if (!user || !pwd) {
      jsonResponse(res, { error: '账号和密码不能为空' }, 400);
      return;
    }

    appendLog('Auth', `正在严格校验天翼云账号密码真实性: ${user} ...`, 'info');

    const tempAccount = { user, password: pwd, deviceCode: devCode };
    const tempClient = new CtYunClient(tempAccount);
    const logRes = await tempClient.login(4);

    if (!logRes.success) {
      appendLog('Auth', `[${name}] 登录校验被拒绝: ${logRes.error}`, 'error');
      jsonResponse(res, { error: logRes.error || '用户名或密码错误，请检查！' }, 400);
      return;
    }

    const loginData = logRes.data;
    const isBound = !!loginData.bondedDevice;
    appendLog('Auth', `[${name}] 🎉 真实登录校验通过！用户ID: ${loginData.userId}，设备绑定: ${isBound ? '已就绪' : '待短信验证'}`, 'success');

    const id = crypto.randomUUID().substring(0, 8);
    const newAcc = {
      id,
      ownerId: currentOwnerId,
      name,
      user,
      password: pwd,
      deviceCode: devCode,
      displayConfig: {
        width: 2560,
        height: 1440,
        scale: 150
      },
      enabled: true,
      bound: isBound,
      features: {
        keepAlive: true,
        autoSign: true,
        aiChat: true,
        cloudHang: true,
        autoRedeem: false
      },
      redeemConfig: {
        enabled: false,
        targetType: 'redeem',
        desktopId: '',
        desktopName: '',
        prodId: 17023101,
        prodName: '8C16G升配包1天 (500积分)',
        prodType: 'pointstplupgrade',
        costPoints: 500,
        maxRedeemTimes: 0,
        scheduleType: 'monthly_days',
        monthlyDays: [-1],
        intervalDays: 1,
        lastRedeemDate: ''
      },
      stats: {
        lastSignTime: '',
        lastAiChatTime: '',
        lastHangTime: '',
        hangMinutesToday: 0,
        points: 0,
        keepAliveStatus: 'online',
        lastError: ''
      }
    };

    appConfig.accounts.push(newAcc);
    saveConfig(appConfig);

    const client = getClient(newAcc);
    client.loginInfo = loginData;
    client.startKeepAliveWorker();

    jsonResponse(res, newAcc, 201);
    return;
  }

  // 9. 更新账号
  if (req.method === 'PUT' && pathname.startsWith('/api/accounts/')) {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }

    const accId = pathname.split('/')[3];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc) {
      jsonResponse(res, { error: '账号不存在' }, 404);
      return;
    }

    if (!canUserAccessAccount(session, acc)) {
      jsonResponse(res, { error: '权限不足：无权修改该云电脑账号' }, 403);
      return;
    }

    const body = await parseJsonBody(req);
    if (body.name) acc.name = body.name;
    if (body.user) acc.user = body.user;
    if (body.password) acc.password = body.password;
    if (body.deviceCode) acc.deviceCode = body.deviceCode;
    if (body.displayConfig) acc.displayConfig = { ...acc.displayConfig, ...body.displayConfig };
    if (typeof body.enabled === 'boolean') acc.enabled = body.enabled;
    if (typeof body.bound === 'boolean') acc.bound = body.bound;
    if (body.features) acc.features = { ...acc.features, ...body.features };
    if (body.redeemConfig) acc.redeemConfig = { ...acc.redeemConfig, ...body.redeemConfig };
    if (body.stats) acc.stats = { ...acc.stats, ...body.stats };

    saveConfig(appConfig);
    appendLog('System', `已更新账号配置: ${acc.name}`, 'info');

    const client = getClient(acc);
    if (acc.enabled && acc.features?.keepAlive !== false) {
      if (!client.workerRunning) client.startKeepAliveWorker();
    } else {
      client.stopKeepAliveWorker();
    }

    jsonResponse(res, acc);
    return;
  }

  // 10. 删除账号
  if (req.method === 'DELETE' && pathname.startsWith('/api/accounts/')) {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }

    const accId = pathname.split('/')[3];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc) {
      jsonResponse(res, { error: '账号不存在' }, 404);
      return;
    }

    if (!canUserAccessAccount(session, acc)) {
      jsonResponse(res, { error: '权限不足：无权删除该云电脑账号' }, 403);
      return;
    }

    const idx = appConfig.accounts.findIndex(a => a.id === accId);
    if (idx >= 0) {
      const deleted = appConfig.accounts.splice(idx, 1)[0];
      const client = clientInstances.get(accId);
      if (client) client.stopKeepAliveWorker();
      clientInstances.delete(accId);

      saveConfig(appConfig);
      appendLog('System', `已删除账号: ${deleted.name}`, 'warning');
      jsonResponse(res, { success: true });
    } else {
      jsonResponse(res, { error: '账号不存在' }, 404);
    }
    return;
  }

  // 11. 生成设备码
  if (req.method === 'POST' && pathname === '/api/device/generate') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }
    jsonResponse(res, { deviceCode: generateDeviceCode() });
    return;
  }

  // 12. 发送短信验证码
  if (req.method === 'POST' && pathname.includes('/send-sms')) {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }

    const accId = pathname.split('/')[3];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc) {
      jsonResponse(res, { error: '账号不存在' }, 404);
      return;
    }

    if (!canUserAccessAccount(session, acc)) {
      jsonResponse(res, { error: '权限不足：无权操作该云电脑账号' }, 403);
      return;
    }

    const client = getClient(acc);
    try {
      appendLog('Auth', `[${acc.name}] 正在请求天翼云下发设备绑定验证码...`, 'info');
      const capCode = await client.getCaptchaCode(acc.user);
      const url = `https://desk.ctyun.cn:8810/api/cdserv/client/device/getSmsCode?mobilePhone=${acc.user}&captchaCode=${capCode}`;
      const resSms = await fetch(url, { headers: client.getSignedHeaders() });
      const dataSms = await resSms.json();
      if (dataSms.code === 0) {
        appendLog('Auth', `[${acc.name}] 短信验证码已发送至手机 ${acc.user}`, 'success');
        jsonResponse(res, { success: true, message: '验证码发送成功' });
      } else {
        appendLog('Auth', `[${acc.name}] 发送短信失败: ${dataSms.msg}`, 'error');
        jsonResponse(res, { error: dataSms.msg || '发送短信失败' }, 400);
      }
    } catch (e) {
      jsonResponse(res, { error: e.message }, 500);
    }
    return;
  }

  // 13. 绑定短信验证码
  if (req.method === 'POST' && pathname.includes('/bind-sms')) {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }

    const accId = pathname.split('/')[3];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc) {
      jsonResponse(res, { error: '账号不存在' }, 404);
      return;
    }

    if (!canUserAccessAccount(session, acc)) {
      jsonResponse(res, { error: '权限不足：无权操作该云电脑账号' }, 403);
      return;
    }

    const body = await parseJsonBody(req);
    const code = (body.verificationCode || '').trim();
    if (!code) {
      jsonResponse(res, { error: '验证码不能为空' }, 400);
      return;
    }
    const client = getClient(acc);
    try {
      const url = `https://desk.ctyun.cn:8810/api/cdserv/client/device/binding?verificationCode=${code}&deviceName=Chrome%E6%B5%8F%E8%A7%88%E5%99%A8&deviceCode=${acc.deviceCode}&deviceModel=Windows+NT+10.0%3B+Win64%3B+x64&sysVersion=Windows+NT+10.0%3B+Win64%3B+x64&appVersion=3.2.0&hostName=pc.ctyun.cn&deviceInfo=Win32`;
      const bindRes = await fetch(url, { method: 'POST', headers: client.getSignedHeaders() });
      const bindData = await bindRes.json();
      if (bindData.code === 0) {
        acc.bound = true;
        saveConfig(appConfig);
        appendLog('Auth', `[${acc.name}] 恭喜！新设备验证通过，设备码永久信任！`, 'success');
        client.startKeepAliveWorker();
        jsonResponse(res, { success: true, message: '设备绑定成功！' });
      } else {
        appendLog('Auth', `[${acc.name}] 设备绑定失败: ${bindData.msg}`, 'error');
        jsonResponse(res, { error: bindData.msg || '绑定失败' }, 400);
      }
    } catch (e) {
      jsonResponse(res, { error: e.message }, 500);
    }
    return;
  }

  // 14. 手动执行真实任务 (真机自动化无头执行)
  if (req.method === 'POST' && pathname.includes('/run/')) {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }

    const parts = pathname.split('/');
    const accId = parts[3];
    const taskType = parts[5];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc) {
      jsonResponse(res, { error: '账号不存在' }, 404);
      return;
    }

    if (!canUserAccessAccount(session, acc)) {
      jsonResponse(res, { error: '权限不足：无权操作该云电脑账号' }, 403);
      return;
    }

    const client = getClient(acc);
    const now = getBeijingTimeString();

    try {
      if (taskType === 'sign') {
        appendLog('Sign', `[${acc.name}] 正在启动真实云电脑页面完成【登录AI云电脑】打卡...`, 'info');
        const displayCfg = acc.displayConfig || { width: 2560, height: 1440, scale: 150 };
        executeRealHang(acc.user, acc.password, ocrEngine, 10, displayCfg, (src, msg, lvl) => appendLog(src, `[${acc.name}] ${msg}`, lvl))
          .then(async () => {
            acc.stats.lastSignTime = now;
            saveConfig(appConfig);
            await client.refreshOfficialTasks();
            appendLog('Sign', `[${acc.name}] 官方打卡已成功，当前官方积分: ${client.metrics.userPoints}`, 'success');
          })
          .catch(err => appendLog('Sign', `[${acc.name}] 打卡执行异常: ${err.message}`, 'error'));

        jsonResponse(res, { message: `[${acc.name}] 真实打卡任务已在后台启动执行，官方进度将自动更新` });
        return;

      } else if (taskType === 'aiChat') {
        appendLog('AIChat', `[${acc.name}] 正在启动无头浏览器执行真实天翼 AI 对话任务...`, 'info');
        executeRealAiChat(acc.user, acc.password, ocrEngine, (src, msg, lvl) => appendLog(src, `[${acc.name}] ${msg}`, lvl))
          .then(async () => {
            acc.stats.lastAiChatTime = now;
            saveConfig(appConfig);
            await client.refreshOfficialTasks();
            appendLog('AIChat', `[${acc.name}] 官方 AI 对话任务已达成！+100 积分已入账，总积分: ${client.metrics.userPoints}`, 'success');
          })
          .catch(err => appendLog('AIChat', `[${acc.name}] AI 对话任务异常: ${err.message}`, 'error'));

        jsonResponse(res, { message: `[${acc.name}] 真实 AI 对话任务已在后台执行，AI 回复后自动计分` });
        return;

      } else if (taskType === 'hang') {
        appendLog('Hang', `[${acc.name}] 启动云电脑真实网页端挂机 (持续保持云电脑运行状态以累加官方秒数)...`, 'info');
        if (!client.wsAlive) {
          client.startKeepAliveWorker();
        }

        // 检查官方任务是否已满 1 小时 (3600秒 或 status === 2)
        await client.refreshOfficialTasks();
        const hangTask = client.metrics.officialTasks.find(t => t.name.includes('使用1小时'));
        const alreadyCompleted = hangTask && (hangTask.status === 2 || (hangTask.total > 0 && hangTask.current >= hangTask.total));
        
        // 若已经满1小时，登录进入后保持10秒即可自动退出释放资源！若未满1小时，则保持挂机120秒持续累加
        const hangDuration = alreadyCompleted ? 10 : 120;
        if (alreadyCompleted) {
          appendLog('Hang', `[${acc.name}] 今日挂机1小时任务已全部达成 (3600秒达成)，本次将执行10秒快速心跳同步并退出释放资源...`, 'info');
        }

        const displayCfg = acc.displayConfig || { width: 2560, height: 1440, scale: 150 };
        executeRealHang(acc.user, acc.password, ocrEngine, hangDuration, displayCfg, (src, msg, lvl) => appendLog(src, `[${acc.name}] ${msg}`, lvl))
          .then(async () => {
            acc.stats.lastHangTime = now;
            saveConfig(appConfig);
            await client.refreshOfficialTasks();
            const curSec = hangTask ? hangTask.current : 0;
            appendLog('Hang', `[${acc.name}] 挂机任务已同步完成: 官方后台记录已累计 ${curSec} / 3600 秒`, 'success');
          })
          .catch(err => appendLog('Hang', `[${acc.name}] 挂机自动化异常: ${err.message}`, 'error'));

        jsonResponse(res, { message: alreadyCompleted ? `[${acc.name}] 今日已满1小时，已启动10秒快速同步` : `[${acc.name}] 云电脑挂机已启动并在真实运行中，官方秒数将自动累加` });
        return;

      } else if (taskType === 'redeem') {
        appendLog('Redeem', `[${acc.name}] 正在拉取天翼云商城最新真实奖品...`, 'info');
        const list = await client.getRewards();
        appendLog('Redeem', `[${acc.name}] 商城连通正常，获取到 ${list.length} 种最新可兑换商品`, 'success');
        jsonResponse(res, { message: `[${acc.name}] 商城查询成功，当前共有 ${list.length} 种商品` });
        return;
      }
    } catch (e) {
      appendLog('Task', `[${acc.name}] 任务执行失败: ${e.message}`, 'error');
      jsonResponse(res, { error: e.message }, 500);
      return;
    }
  }

  // 15. 获取真实商品列表
  if (req.method === 'GET' && pathname === '/api/rewards') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }

    let dynamicRewards = null;
    let allowedAccounts = appConfig.accounts;
    if (session.role !== 'admin') {
      allowedAccounts = appConfig.accounts.filter(a => a.ownerId === session.userId);
    }

    for (const acc of allowedAccounts) {
      try {
        const client = getClient(acc);
        const list = await client.getRewards();
        if (list && list.length > 0) {
          dynamicRewards = list;
          break;
        }
      } catch (e) {}
    }

    if (dynamicRewards && dynamicRewards.length > 0) {
      jsonResponse(res, dynamicRewards);
      return;
    }

    const fallback = [
      { prodId: 17023101, prodName: '8C16G升配包1天', costPoints: 500, prodType: 'pointstplupgrade', description: '可将AI云电脑升配至8C16G，最多支持兑换365天；月末兑换可维持长期8C16G' },
      { prodId: 17023111, prodName: '16C32G升配包1天', costPoints: 1000, prodType: 'pointstplupgrade', description: '可将AI云电脑（政企版）升配至16C32G，最多支持兑换365天' },
      { prodId: 17020101, prodName: 'AI应用中心高级版 (1个月)', costPoints: 1000, prodType: 'cpcai', description: '权益：支持DeepSeek满血版、专属智库等，有效期1个月' },
      { prodId: 17010101, prodName: '专属智库1G存储空间', costPoints: 1000, prodType: 'cpcai', description: '基于当前AI应用中心存储空间，叠加1G存储空间，每月限兑5次' },
      { prodId: 17024101, prodName: '1G数据盘永久扩容', costPoints: 1200, prodType: 'pointsdiskupgrade', description: '兑换后，将自动创建1个新数据盘，最大不超过500GB' }
    ];
    jsonResponse(res, fallback);
    return;
  }

  // 16. 获取云电脑列表
  if (req.method === 'GET' && pathname.includes('/desktops')) {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }

    const accId = pathname.split('/')[3];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc) {
      jsonResponse(res, { error: '账号不存在' }, 404);
      return;
    }

    if (!canUserAccessAccount(session, acc)) {
      jsonResponse(res, { error: '权限不足：无权查看该云电脑设备' }, 403);
      return;
    }

    const client = getClient(acc);
    try {
      const list = await client.getDesktops();
      const formatted = list.map(d => ({
        desktopId: d.objId || d.desktopId,
        desktopName: d.objName || d.desktopName || '云电脑',
        useStatusText: d.useStatusText || '运行中'
      }));
      jsonResponse(res, formatted);
    } catch (e) {
      jsonResponse(res, []);
    }
    return;
  }

  // 获取云电脑 Web 直达访问参数 API (包括目标页面 URL、设备码与免密凭证信息)
  if (req.method === 'GET' && pathname.startsWith('/api/accounts/') && pathname.endsWith('/web-launch')) {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }

    const accId = pathname.split('/')[3];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc) {
      jsonResponse(res, { error: '账号不存在' }, 404);
      return;
    }

    if (!canUserAccessAccount(session, acc)) {
      jsonResponse(res, { error: '权限不足：无权访问该账号' }, 403);
      return;
    }

    const client = getClient(acc);
    try {
      const desktops = await client.getDesktops();
      if (!desktops || desktops.length === 0) {
        jsonResponse(res, { error: '未检测到可用云电脑' }, 400);
        return;
      }
      const desktop = desktops[0];
      const objId = desktop.objId || desktop.desktopId;
      const b64Id = Buffer.from(String(objId)).toString('base64');
      const targetUrl = `https://pc.ctyun.cn/#/desktop?id=${encodeURIComponent(b64Id)}`;

      const displayCfg = acc.displayConfig || { width: 2560, height: 1440, scale: 150 };

      jsonResponse(res, {
        success: true,
        user: acc.user,
        deviceCode: acc.deviceCode,
        targetUrl,
        desktopName: desktop.objName || desktop.desktopName || '云电脑',
        displayConfig: displayCfg
      });
    } catch (e) {
      jsonResponse(res, { error: e.message }, 500);
    }
    return;
  }

  // 手动下单兑换/抽奖接口
  if (req.method === 'POST' && pathname.startsWith('/api/accounts/') && pathname.endsWith('/order')) {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }

    const accId = pathname.split('/')[3];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc) {
      jsonResponse(res, { error: '账号不存在' }, 404);
      return;
    }

    if (!canUserAccessAccount(session, acc)) {
      jsonResponse(res, { error: '权限不足：无权操作该账号' }, 403);
      return;
    }

    const body = await parseJsonBody(req);
    const prodId = parseInt(body.prodId);
    const prodName = body.prodName || '商品';
    const prodType = body.prodType || 'pointstplupgrade';
    const costPoints = parseInt(body.costPoints) || 0;
    const desktopId = parseInt(body.desktopId) || 0;
    const times = Math.max(1, parseInt(body.times) || 1);

    if (!prodId || costPoints <= 0) {
      jsonResponse(res, { error: '商品参数无效' }, 400);
      return;
    }

    const client = getClient(acc);
    try {
      await client.refreshOfficialTasks();
      const currentPts = client.metrics.userPoints || 0;
      const totalCost = costPoints * times;
      if (currentPts < totalCost) {
        jsonResponse(res, { error: `积分不足：当前拥有 ${currentPts} 积分，本次兑换需要 ${totalCost} 积分！` }, 400);
        return;
      }

      appendLog('Redeem', `[${acc.name}] 正在向天翼云发起真实下单: ${prodName} x${times}，消耗 ${totalCost} 积分...`, 'info');

      const placeOrderUrl = 'https://desk.ctyun.cn/selforder/api/selforder/paas/placeOrder';
      const orderPayload = {
        busiChannel: '010',
        orderType: 1,
        pointType: 1,
        points: totalCost,
        sku: Array.from({ length: times }).map((_, idx) => ({
          execSort: idx + 1,
          prodId,
          prodType,
          attrs: desktopId ? [{ attrKey: 'bindDesktopId', attrVal: desktopId }] : []
        }))
      };

      const orderRes = await fetch(placeOrderUrl, {
        method: 'POST',
        headers: client.getSignedHeaders({ 'Content-Type': 'application/json;charset=UTF-8' }),
        body: JSON.stringify(orderPayload)
      });
      const orderData = await orderRes.json();

      if (orderData.code === 0) {
        await client.refreshOfficialTasks();
        appendLog('Redeem', `[${acc.name}] 🎉 恭喜！成功兑换【${prodName} x${times}】，已消耗 ${totalCost} 积分！`, 'success');
        sendNotification(
          appConfig.settings,
          `🎉 天翼云积分兑换成功 - ${acc.name}`,
          `账号 [${acc.name}] 成功兑换 [${prodName} x${times}]，扣除 ${totalCost} 积分，当前剩余: ${client.metrics.userPoints} 积分。`
        );
        jsonResponse(res, { success: true, message: `兑换成功！消耗 ${totalCost} 积分，剩余 ${client.metrics.userPoints} 积分` });
      } else {
        appendLog('Redeem', `[${acc.name}] 下单失败: ${orderData.msg || '未知错误'}`, 'error');
        jsonResponse(res, { error: `兑换失败(${orderData.code}): ${orderData.msg || '未知原因'}` }, 400);
      }
    } catch (e) {
      jsonResponse(res, { error: `下单请求异常: ${e.message}` }, 500);
    }
    return;
  }

  // 云电脑电源管理操作 API (开机 / 重启 / 关机)
  if (req.method === 'POST' && pathname.startsWith('/api/accounts/') && pathname.includes('/power/')) {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }

    const parts = pathname.split('/');
    const accId = parts[3];
    const action = parts[5]; // poweron / reboot / shutdown
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc) {
      jsonResponse(res, { error: '账号不存在' }, 404);
      return;
    }

    if (!canUserAccessAccount(session, acc)) {
      jsonResponse(res, { error: '权限不足：无权操作该账号' }, 403);
      return;
    }

    const client = getClient(acc);
    try {
      const desktops = await client.getDesktops();
      if (!desktops || desktops.length === 0) {
        jsonResponse(res, { error: '未检测到可用云电脑' }, 400);
        return;
      }
      const desktopId = desktops[0].objId || desktops[0].desktopId;
      const resPower = await client.controlPower(desktopId, action);
      if (resPower.success) {
        jsonResponse(res, resPower);
      } else {
        jsonResponse(res, resPower, 400);
      }
    } catch (e) {
      jsonResponse(res, { error: e.message }, 500);
    }
    return;
  }

  // 17. 系统全局设置
  if (req.method === 'GET' && pathname === '/api/settings') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }
    jsonResponse(res, appConfig.settings || {});
    return;
  }

  if (req.method === 'PUT' && pathname === '/api/settings') {
    const session = getSessionFromReq(req);
    // 严格鉴权：必须是已登录且角色为 admin，访客(未登录)返回 401，非管理员返回 403
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再修改全局系统设置' }, 401);
      return;
    }
    if (session.role !== 'admin') {
      jsonResponse(res, { error: '权限不足：仅超级管理员可修改全局系统设置' }, 403);
      return;
    }

    const body = await parseJsonBody(req);
    
    // SSRF 防御校验：检查 Webhook 地址合法性
    if (body.notify && body.notify.webhookUrl) {
      const targetUrl = String(body.notify.webhookUrl).trim();
      if (body.notify.enabled && !isValidWebhookUrl(targetUrl)) {
        jsonResponse(res, { error: '安全拦截：禁止设置内网/私有IP或非法协议作为 Webhook 推送目标！' }, 400);
        return;
      }
    }

    appConfig.settings = { ...appConfig.settings, ...body };
    saveConfig(appConfig);
    appendLog('System', '全局设置已更新，配额、保活周期与通知配置已生效', 'info');

    // 联动热更新：更新正在运行中所有云电脑客户端的保活重连周期并即时重设倒计时
    const newKeepSeconds = appConfig.settings.keepAliveSeconds || 60;
    for (const [id, client] of clientInstances.entries()) {
      if (client.resetCycleTimeout) {
        client.resetCycleTimeout(newKeepSeconds);
      } else {
        client.metrics.keepAliveSeconds = newKeepSeconds;
        client.metrics.cycleCountdown = newKeepSeconds;
      }
    }

    if (appConfig.settings.notify?.enabled) {
      sendNotification(
        appConfig.settings,
        '天翼云控制中心 - 通知配置成功',
        '您的 Webhook / 推送通知配置已成功生效！'
      );
    }

    jsonResponse(res, appConfig.settings);
    return;
  }

  // 18. 测试通知推送 API (严格要求必须登录且为管理员，并做 SSRF 强校验)
  if (req.method === 'POST' && pathname === '/api/notify/test') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再测试推送' }, 401);
      return;
    }
    if (session.role !== 'admin') {
      jsonResponse(res, { error: '权限不足：仅超级管理员可测试推送' }, 403);
      return;
    }

    const body = await parseJsonBody(req);
    const testUrl = (body.webhookUrl || appConfig.settings?.notify?.webhookUrl || '').trim();
    if (!isValidWebhookUrl(testUrl)) {
      jsonResponse(res, { success: false, message: '安全拦截：目标 URL 为内网/本地私有地址或协议非法，已被系统拒绝！' }, 400);
      return;
    }

    const testSettings = {
      notify: {
        enabled: true,
        channel: body.channel || appConfig.settings?.notify?.channel,
        webhookUrl: testUrl,
        customTitleTemplate: body.customTitleTemplate || appConfig.settings?.notify?.customTitleTemplate,
        customContentTemplate: body.customContentTemplate || appConfig.settings?.notify?.customContentTemplate
      }
    };
    const resNotify = await sendNotification(
      testSettings,
      '天翼云自动化控制中心 - 测试推送',
      '这是一条即时测试消息，证明您的推送通道与自定义模板已成功配置并联通！',
      { account: '测试账号', task: '签到打卡', status: '成功', points: '1000' }
    );
    jsonResponse(res, resNotify);
    return;
  }

  // 19. 配置导出与备份接口 (导出当前用户或管理员所有账号与设置)
  if (req.method === 'GET' && pathname === '/api/config/export') {
    const session = getSessionFromReq(req, parsedUrl);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再导出配置' }, 401);
      return;
    }

    let exportAccounts = appConfig.accounts;
    if (session.role !== 'admin') {
      exportAccounts = appConfig.accounts.filter(a => a.ownerId === session.userId);
    }

    const exportData = {
      exportVersion: '1.0.0',
      exportTime: getBeijingTimeString(),
      exportedBy: session.username,
      role: session.role,
      settings: session.role === 'admin' ? appConfig.settings : undefined,
      accounts: exportAccounts.map(a => ({
        name: a.name,
        user: a.user,
        password: a.password,
        deviceCode: a.deviceCode,
        displayConfig: a.displayConfig,
        enabled: a.enabled,
        features: a.features,
        redeemConfig: a.redeemConfig
      }))
    };

    appendLog('System', `用户 [${session.username}] 导出了 ${exportAccounts.length} 个账号的配置备份`, 'info');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="ctyun_config_backup_${Date.now()}.json"`,
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(exportData, null, 2));
    return;
  }

  // 20. 配置导入与恢复接口 (支持追加或覆盖，导入后自动平滑重载保活长连接)
  if (req.method === 'POST' && pathname === '/api/config/import') {
    const session = getSessionFromReq(req, parsedUrl);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再导入配置' }, 401);
      return;
    }

    const body = await parseJsonBody(req);
    const importAccounts = Array.isArray(body.accounts) ? body.accounts : [];
    if (importAccounts.length === 0) {
      jsonResponse(res, { error: '导入失败：未在 JSON 文件中解析到合法的 accounts 数组' }, 400);
      return;
    }

    const mode = body.mode || 'merge'; // merge (合并新增) 或 overwrite (覆盖当前名下)
    const targetOwnerId = session.userId;
    const currentUser = authManager.getUserById(targetOwnerId);

    // 配额计算
    if (currentUser && currentUser.role !== 'admin') {
      const currentOwned = mode === 'overwrite' ? 0 : appConfig.accounts.filter(a => a.ownerId === targetOwnerId).length;
      if (currentOwned + importAccounts.length > (currentUser.maxQuota || 2)) {
        jsonResponse(res, {
          error: `导入失败：导入后账号数量 (${currentOwned + importAccounts.length}) 超出允许配额上限 (${currentUser.maxQuota}台)！`
        }, 400);
        return;
      }
    }

    if (mode === 'overwrite') {
      // 停止并清理当前用户原有保活
      const oldOwned = appConfig.accounts.filter(a => a.ownerId === targetOwnerId);
      oldOwned.forEach(o => {
        const cl = clientInstances.get(o.id);
        if (cl) cl.stopKeepAliveWorker();
        clientInstances.delete(o.id);
      });
      appConfig.accounts = appConfig.accounts.filter(a => a.ownerId !== targetOwnerId);
    }

    let importedCount = 0;
    for (const item of importAccounts) {
      if (!item.user || !item.password) continue;

      // 如果是 merge，检查手机号是否已存在
      const existing = appConfig.accounts.find(a => a.user === item.user && a.ownerId === targetOwnerId);
      if (existing) {
        existing.name = item.name || existing.name;
        existing.password = item.password;
        if (item.deviceCode) existing.deviceCode = item.deviceCode;
        if (item.displayConfig) existing.displayConfig = { ...existing.displayConfig, ...item.displayConfig };
        if (item.features) existing.features = { ...existing.features, ...item.features };
        if (item.redeemConfig) existing.redeemConfig = { ...existing.redeemConfig, ...item.redeemConfig };
        importedCount++;
        continue;
      }

      const id = crypto.randomUUID().substring(0, 8);
      const newAcc = {
        id,
        ownerId: targetOwnerId,
        name: item.name || item.user,
        user: item.user,
        password: item.password,
        deviceCode: item.deviceCode || generateDeviceCode(),
        displayConfig: item.displayConfig || { width: 2560, height: 1440, scale: 150 },
        enabled: item.enabled !== false,
        bound: true,
        features: item.features || {
          keepAlive: true,
          autoSign: true,
          aiChat: true,
          cloudHang: true,
          autoRedeem: false
        },
        redeemConfig: item.redeemConfig || {
          enabled: false,
          targetType: 'redeem',
          desktopId: '',
          desktopName: '',
          prodId: 17023101,
          prodName: '8C16G升配包1天 (500积分)',
          prodType: 'pointstplupgrade',
          costPoints: 500,
          maxRedeemTimes: 0,
          scheduleType: 'monthly_days',
          monthlyDays: [-1],
          intervalDays: 1,
          lastRedeemDate: ''
        },
        stats: {
          lastSignTime: '',
          lastAiChatTime: '',
          lastHangTime: '',
          hangMinutesToday: 0,
          points: 0,
          keepAliveStatus: 'online',
          lastError: ''
        }
      };
      appConfig.accounts.push(newAcc);
      importedCount++;

      // 自动唤醒长连接保活
      const client = getClient(newAcc);
      client.startKeepAliveWorker();
    }

    // 管理员导入时若带 settings 则一并更新
    if (session.role === 'admin' && body.settings && typeof body.settings === 'object') {
      appConfig.settings = { ...appConfig.settings, ...body.settings };
    }

    saveConfig(appConfig);
    appendLog('System', `用户 [${session.username}] 成功导入/恢复了 ${importedCount} 个云电脑配置`, 'success');
    jsonResponse(res, { success: true, importedCount, message: `成功导入 ${importedCount} 个账号配置并自动上线保活！` });
    return;
  }

  // 21. 重启保活守护
  if (req.method === 'POST' && pathname === '/api/keeper/restart') {
    appendLog('Keeper', '收到重启指令，正在重置所有保活周期...', 'warning');
    for (const [id, client] of clientInstances.entries()) {
      client.stopKeepAliveWorker();
    }
    setTimeout(initAllKeepAlive, 1500);
    jsonResponse(res, { message: '所有保活守护通道已重新初始化' });
    return;
  }

  jsonResponse(res, { error: 'Not Found' }, 404);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`===========================================================`);
  console.log(`🚀 天翼云全功能多账号可视化管理平台已完全就绪！`);
  console.log(`👉 控制台访问地址: http://127.0.0.1:${PORT}`);
  console.log(`===========================================================`);
  appendLog('System', `控制台服务已就绪，当前加载 ${appConfig.accounts.length} 个账号`, 'success');
});
