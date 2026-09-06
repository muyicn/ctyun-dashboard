const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const WebSocket = require('ws');
const LightweightOcr = require('./app/lightweight_ocr');
const CtYunEncryption = require('./app/ctyun_encryption');
const { executeNativeAiChat, executeNativeSign, executeNativeHang } = require('./app/tasks/native_tasks');
const { AuthManager } = require('./app/auth_manager');
const { TaskScheduler } = require('./app/tasks/scheduler');

// 全局异常拦截看门狗 (确保守护服务长期稳定运行不宕机)
process.on('uncaughtException', (err) => {
  console.error('[!] 系统未捕获异常已拦截 (常驻保障):', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[!] 系统未处理 Promise 拒绝已拦截:', reason?.message || reason);
});

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
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function getBeijingTimeOnly() {
  const d = new Date();
  return d.toLocaleTimeString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function getBeijingDateOnly() {
  const d = new Date();
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

let logIdCounter = 0;

function isHeartbeatOrRoutine(source, message) {
  if (source === 'Heartbeat') return true;
  if (!message) return false;
  return message.includes('心跳') || message.includes('保活周期') || message.includes('保持长连接') || message.includes('长连接保活') || message.includes('发送保活') || message.includes('REDQ') || message.includes('103 认证') || message.includes('118 用户身份') || message.includes('118 身份');
}

// 自动日志清理维护定时器：每小时执行一次，自动清理超过 3 天的历史日志或多于 2000 条的数据
setInterval(() => {
  if (logs.length > 1500) {
    logs.splice(0, logs.length - 1000);
  }
}, 3600 * 1000);

function appendLog(source, message, level = 'info', accountName = '') {
  const nowTime = getBeijingTimeString();

  // 全双工智能折叠机制：
  // 1. 同来源同内容的完全一致重复消息合并
  // 2. 心跳/周期性 routine 消息合并（只保留最新一条并叠加次数计数）
  if (logs.length > 0) {
    const last = logs[logs.length - 1];
    const sameAcc = (last.accountName || '') === (accountName || '');
    const sameSrc = last.source === source;
    const sameLvl = last.level === level;

    const isRoutinePair = isHeartbeatOrRoutine(source, message) && isHeartbeatOrRoutine(last.source, last.message);
    const isRepeat = (sameAcc && sameSrc && sameLvl) && (last.message === message || isRoutinePair);

    if (isRepeat) {
      last.timestamp = nowTime;
      last.message = message;
      last.repeatCount = (last.repeatCount || 1) + 1;

      const updatePayload = { ...last, isUpdate: true };
      for (const client of sseClients) {
        try {
          if (canUserSeeLog(client.session, last)) {
            client.res.write(`data: ${JSON.stringify(updatePayload)}\n\n`);
          }
        } catch (e) {
          sseClients.delete(client);
        }
      }
      return;
    }
  }

  // 关键事件、任务达成、异常告警或新业务：单独生成高亮条目
  const entry = {
    id: 'log_' + (++logIdCounter),
    timestamp: nowTime,
    source,
    message,
    level,
    accountName: accountName || '',
    repeatCount: 1
  };

  logs.push(entry);
  if (logs.length > 2000) logs.shift();

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
    '{time}': getBeijingTimeString(),
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
    this.clinkPingTimer = null;
    this.endCurrentSession = null;
    this.isWebUserActive = false; // 用户是否正在通过浏览器操作云电脑
    this.webUserActiveUntil = 0;
  }

  // 用户点击浏览器访问云电脑时调用：立即主动断开后台保活连接，并保持避让让位
  yieldToWebUser(durationMinutes = 60) {
    const accName = this.account.name || this.account.user;
    const wasActive = this.isWebUserActive;
    this.isWebUserActive = true;
    this.webUserActiveUntil = Date.now() + durationMinutes * 60 * 1000;
    
    if (!wasActive) {
      appendLog('KeepAlive', `[${accName}] 🚀 检测到正在打开浏览器访问操作云电脑，后台长连接主动让位断开，杜绝互踢！`, 'info');
    }
    
    if (this.endCurrentSession) {
      this.endCurrentSession('Yield to Web User');
    }
  }

  // 释放避让：用户关闭页面或手动恢复
  async resumeFromWebUser() {
    const accName = this.account.name || this.account.user;
    if (!this.isWebUserActive) return;
    this.isWebUserActive = false;
    this.webUserActiveUntil = 0;

    appendLog('KeepAlive', `[${accName}] 浏览器访问已关闭，恢复后台长连接保活守护与启动监测。`, 'info');

    // 只要账号开启了保活，无论当前是运行中还是关机，一律启动持久巡检守护 (关机时自动转入 20s/10m 持久监测开机)
    if (this.account.enabled && this.account.features?.keepAlive === true) {
      if (!this.workerRunning) {
        this.startKeepAliveWorker();
      }
    }
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
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (!this.loginInfo) {
        const logRes = await this.login();
        if (!logRes.success) throw new Error(logRes.error);
      }

      // 1. 优先使用全规格 pageDesktop 查询云电脑
      try {
        const res = await fetch('https://desk.ctyun.cn:8810/api/desktop/client/pageDesktop', {
          method: 'POST',
          headers: this.getSignedHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            getCnt: 50,
            sortType: 'createTimeV1'
          })
        });
        const json = await res.json();
        if (json.code === 0 && json.data) {
          const list = json.data.desktopList || json.data.desktopPoolList || [];
          if (list.length > 0) {
            this.checkExternalPowerOn(list[0]);
            return list;
          }
        }
      } catch (e) {}

      // 2. 官方备用兜底接口：api/desktop/client/list (覆盖所有自建、公有池与专属云电脑类型)
      try {
        const resList = await fetch('https://desk.ctyun.cn:8810/api/desktop/client/list', {
          method: 'GET',
          headers: this.getSignedHeaders()
        });
        const jsonList = await resList.json();
        if (jsonList.code === 0 && jsonList.data) {
          const list = jsonList.data.desktopList || jsonList.data.desktopPoolList || [];
          if (list.length > 0) {
            this.checkExternalPowerOn(list[0]);
            return list;
          }
        }
      } catch (e) {}

      // 若未查询到，强制刷新凭据重试一次
      if (attempt === 1) {
        this.loginInfo = null;
      }
    }
    return [];
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
      // 若云电脑已关机，服务端返回 desktopInfo 为 null 且带有 goingRetry: true
      return json.data?.desktopInfo || null;
    }
    throw new Error(json.msg || '获取云电脑连接配置失败');
  }

  // 云电脑电源管理操作 (开机: start / 重启: reboot / 关机: shutdown)
  // 云电脑电源管理操作 (开机: operationType 1 / 关机: operationType 2 / 重启: operationType 3)
  async controlPower(desktopId, action) {
    const accName = this.account.name || this.account.user;
    const actionLower = (action || '').toLowerCase();

    // 天翼云底层官方电源管控协议 operationType: 1=开机(ON), 2=关机(SHUTDOWN), 3=重启(RESET)
    let opType = 3;
    let actionCn = '重启';
    if (actionLower === 'poweron' || actionLower === 'start' || actionLower === 'awake') {
      opType = 1;
      actionCn = '开机/唤醒';
    } else if (actionLower === 'shutdown' || actionLower === 'poweroff') {
      opType = 2;
      actionCn = '关机';
    } else {
      opType = 3;
      actionCn = '重启';
    }

    appendLog('System', `[${accName}] 正在向天翼云下达电源控制指令: ${actionCn} (operationType: ${opType})...`, 'info');

    if (!this.loginInfo) {
      const logRes = await this.login();
      if (!logRes.success) throw new Error(logRes.error || '登录鉴权失败');
    }

    const form = new URLSearchParams({
      desktopId: String(desktopId),
      operationType: String(opType)
    });

    try {
      const res = await fetch('https://desk.ctyun.cn:8810/api/desktop/client/operate', {
        method: 'POST',
        headers: this.getSignedHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
        body: form.toString()
      });

      const data = await res.json();
      if (data.code === 0) {
        appendLog('System', `[${accName}] ✅ 云电脑【${actionCn}】指令已成功生效！官方返回: 成功`, 'success');
        sendNotification(
          appConfig.settings,
          `⚡ 云电脑电源控制生效 - ${accName}`,
          `已成功向云电脑 [${accName}] 下达【${actionCn}】电源指令，天翼云已确认执行。`
        );
        let successMsg = `云电脑【${actionCn}】指令已成功下发并生效！`;
        if (opType === 1) {
          successMsg = `云电脑【开机】指令已成功下达天翼云网关！正在开机启动中，后台将持续监听就绪状态并自动上线保活。`;
        }
        return { success: true, message: successMsg };
      } else {
        throw new Error(data.msg || `错误码 ${data.code}`);
      }
    } catch (e) {
      // 容错处理：天翼云返回“只有已关机状态的AI云电脑允许进行开机操作”或机器正在开机中
      if (opType === 1 && e.message && (e.message.includes('只有已关机') || e.message.includes('正在进行') || e.message.includes('运行中'))) {
        appendLog('System', `[${accName}] 云电脑正在开机或已处于运行状态，已自动恢复保活准备。`, 'info');
        return { success: true, message: '云电脑开机指令已同步，正在启动就绪中！' };
      }
      appendLog('System', `[${accName}] ❌ 下发电源指令【${actionCn}】失败: ${e.message}`, 'error');
      return { success: false, error: e.message };
    }
  }

  // 检测外部/官网/控制台开机：若之前处于关机/保活关闭，一旦检测到云电脑真正恢复运行中，自动恢复开启保活
  checkExternalPowerOn(desktop) {
    if (!desktop) return;
    const isRunning = desktop.useStatusText === '运行中' || desktop.useStatus == 25;
    if (isRunning && this.account.features && this.account.features.keepAlive === false) {
      this.account.features.keepAlive = true;
      this.account.manualShutdown = false;
      this.account.stats = this.account.stats || {};
      this.account.stats.keepAliveStatus = 'online';
      saveConfig(appConfig);
      appendLog('KeepAlive', `[${this.account.name || this.account.user}] 🎉 检测到云电脑已成功开机启动，已自动恢复保活开关与后台长连接守护！`, 'success');
      this.startKeepAliveWorker();
    }
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

        const todayStr = getBeijingDateOnly();
        const nowStr = getBeijingTimeString();

        // 1. 登录AI云电脑打卡完成时间点追踪
        const loginTask = this.metrics.officialTasks.find(t => t.name.includes('登录AI云电脑'));
        if (loginTask && (loginTask.status === 2 || loginTask.current >= loginTask.total)) {
          if (!this.account.stats.lastSignTime || !this.account.stats.lastSignTime.startsWith(todayStr)) {
            this.account.stats.lastSignTime = nowStr;
          }
        }

        // 2. AI 智能对话完成时间点追踪
        const aiTask = this.metrics.officialTasks.find(t => t.name.includes('AI对话'));
        if (aiTask && (aiTask.status === 2 || aiTask.current >= aiTask.total)) {
          if (!this.account.stats.lastAiChatTime || !this.account.stats.lastAiChatTime.startsWith(todayStr)) {
            this.account.stats.lastAiChatTime = nowStr;
          }
        }

        // 3. 挂机 1 小时完成时间点追踪
        const hangTask = this.metrics.officialTasks.find(t => t.name.includes('使用1小时'));
        if (hangTask) {
          this.account.stats.hangMinutesToday = Math.floor(hangTask.current / 60);
          if (hangTask.status === 2 || (hangTask.total > 0 && hangTask.current >= hangTask.total)) {
            if (!this.account.stats.lastHangTime || !this.account.stats.lastHangTime.startsWith(todayStr)) {
              this.account.stats.lastHangTime = nowStr;
            }
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
        // 只有当用户在界面上手动把保活开关关闭，才退出守护循环
        if (this.account.features?.keepAlive === false) {
          this.stopKeepAliveWorker();
          break;
        }

        // 若当前用户正在通过网页浏览器直连操控云电脑，后台保活保持静默避让，绝不建连争抢 Session！
        if (this.isWebUserActive) {
          if (Date.now() < this.webUserActiveUntil) {
            this.metrics.status = 'online';
            this.metrics.lastHeartbeatResult = '浏览器用户操作中 (保活避让守护中)';
            await new Promise(r => setTimeout(r, 10000));
            continue;
          } else {
            this.isWebUserActive = false;
          }
        }

        // 1. 查询云电脑当前最新状态
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
        this.metrics.desktopId = desktopId;
        this.metrics.desktopName = desktop.objName || desktop.desktopName || '云电脑';
        if (this.account.stats) this.account.stats.desktopId = desktopId;

        const isRunning = desktop && (desktop.useStatusText === '运行中' || desktop.useStatus == 25);

        // 2. 如果云电脑未处于运行中（已关机 / 正在启动排队）：
        // 按照用户要求：只要保活按钮开启，绝对保持持久监测，绝不退出！
        // 前 5 分钟每隔 20 秒高频监测一次；5 分钟后转为 10 分钟一次持久巡检，随时响应外部开机自启！
        if (!isRunning) {
          this.metrics.status = 'offline';
          this.metrics.lastHeartbeatResult = `云电脑处于 [${desktop.useStatusText || '未启动'}] 状态，后台持续监测就绪中...`;
          
          this.bootWaitStartTime = this.bootWaitStartTime || Date.now();
          const elapsedSec = Math.floor((Date.now() - this.bootWaitStartTime) / 1000);
          
          if (elapsedSec < 300) {
            appendLog('KeepAlive', `[${accName}] 云电脑处于 [${desktop.useStatusText || '未启动'}] 状态，正在以 20s 频率持续监测就绪 (${elapsedSec}s/300s)...`, 'info');
            await new Promise(r => setTimeout(r, 20000));
          } else {
            appendLog('KeepAlive', `[${accName}] 云电脑未启动，进入长效持久监测守护 (每 10 分钟探测一次，随时响应外部开机)...`, 'info');
            await new Promise(r => setTimeout(r, 600000));
          }
          continue;
        }

        // 3. 云电脑已处于运行中，重置启动等待计时
        this.bootWaitStartTime = null;

        const keepSeconds = appConfig.settings?.keepAliveSeconds || 60;
        this.metrics.keepAliveSeconds = keepSeconds;
        appendLog('Heartbeat', `[${accName}] === 新保活周期开始 (设定保持: ${keepSeconds}秒) ===`, 'info');

        // 4. 获取长连接视讯流配置 (开机后网关就绪可能有轻微延迟，温和重试多次)
        let desktopInfo = null;
        for (let connAttempt = 1; connAttempt <= 5; connAttempt++) {
          desktopInfo = await this.connect(desktopId);
          if (desktopInfo && desktopInfo.clinkLvsOutHost) break;
          if (connAttempt < 5) {
            appendLog('KeepAlive', `[${accName}] 云电脑已开机，视讯网关就绪排队中 (${connAttempt * 5}s/25s)...`, 'info');
            await new Promise(r => setTimeout(r, 5000));
          }
        }

        if (!desktopInfo || !desktopInfo.clinkLvsOutHost) {
          appendLog('KeepAlive', `[${accName}] 视讯网关暂未分配完毕，20秒后自动重新探测连接...`, 'warning');
          await new Promise(r => setTimeout(r, 20000));
          continue;
        }

        this.metrics.currentHost = desktopInfo.clinkLvsOutHost;
        const wsUrl = `wss://${desktopInfo.clinkLvsOutHost}/clinkProxy/${desktopId}/MAIN`;

        await new Promise((resolveSession) => {
          let cycleDone = false;
          let sessionTimeout = null;

          const endSession = (reason) => {
            if (cycleDone) return;
            cycleDone = true;
            this.endCurrentSession = null;
            if (sessionTimeout) clearTimeout(sessionTimeout);
            if (this.countdownTimer) clearInterval(this.countdownTimer);
            if (this.clinkPingTimer) {
              clearInterval(this.clinkPingTimer);
              this.clinkPingTimer = null;
            }
            if (this.ws) {
              try { this.ws.close(); } catch (e) {}
            }
            this.wsAlive = false;
            resolveSession();
          };

          this.endCurrentSession = endSession;

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

          this.ws = new WebSocket(wsUrl, {
            headers: { Origin: 'https://pc.ctyun.cn' },
            rejectUnauthorized: false
          });

          const safeSend = (data) => {
            try {
              if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(data);
              }
            } catch (err) {
              appendLog('Heartbeat', `[${accName}] 报文发送异常: ${err.message}`, 'warning');
            }
          };

          this.ws.on('open', () => {
            this.wsAlive = true;
            this.metrics.status = 'online';
            this.metrics.successCount++;
            this.account.stats = this.account.stats || {};
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
            safeSend(JSON.stringify(connectMsg));

            setTimeout(() => {
              const initBuf = Buffer.from('UkVEUQIAAAACAAAAGgAAAAAAAAABAAEAAAABAAAAEgAAAAkAAAAECAAA', 'base64');
              safeSend(initBuf);
              appendLog('Heartbeat', `[${accName}] 已发送保活特征码报文 (UkVEUQIA...)`, 'info');
            }, 500);
          });

          this.ws.on('message', (data) => {
            try {
              const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
              const hex = buf.toString('hex').toUpperCase();

              // 收到任一有效业务报文，均确保证书与连接状态为在线
              this.wsAlive = true;
              this.metrics.status = 'online';
              if (this.account.stats) this.account.stats.keepAliveStatus = 'online';

              if (hex.startsWith('52454451')) {
                const nowStr = getBeijingTimeOnly();
                appendLog('Heartbeat', `[${accName}][${this.metrics.desktopName}] 收到服务端保活校验 REDQ (${buf.length}B)`, 'info');

                const responseBuf = this.encryptor.execute(buf);
                safeSend(responseBuf);

                this.metrics.lastHeartbeatTime = nowStr;
                this.metrics.lastHeartbeatResult = `REDQ 校验成功，已回传 ${responseBuf.length} 字节加密应答 (${nowStr})`;
                appendLog('Heartbeat', `[${accName}][${this.metrics.desktopName}] -> ✅ 成功回传 RSA-OAEP 加密应答 (${responseBuf.length}B)`, 'success');
                return;
              }

              if (buf.length >= 6) {
                const type = buf.readUInt16LE(0);
                const size = buf.readUInt32LE(2);

                // 响应服务端 PING (Type 4) -> 自动回传 PONG (Type 3)
                if (type === 4) {
                  const pongBuf = Buffer.alloc(6 + Math.min(size, 12));
                  pongBuf.writeUInt16LE(3, 0); // CLINK_MSGC_PONG = 3
                  pongBuf.writeUInt32LE(Math.min(size, 12), 2);
                  if (size > 0 && buf.length >= 6 + Math.min(size, 12)) {
                    buf.copy(pongBuf, 6, 6, 6 + Math.min(size, 12));
                  }
                  safeSend(pongBuf);
                  return;
                }

                // 响应服务端 ACK_SYNC (Type 3) -> 回传 Type 1 (CLINK_MSGC_ACK_SYNC)
                if (type === 3 && size >= 8) {
                  const gen = buf.readUInt32LE(6);
                  const ackBuf = Buffer.alloc(10);
                  ackBuf.writeUInt16LE(1, 0); // CLINK_MSGC_ACK_SYNC = 1
                  ackBuf.writeUInt32LE(4, 2);
                  ackBuf.writeUInt32LE(gen, 6);
                  safeSend(ackBuf);
                  return;
                }

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

                  safeSend(sendBuf);
                  appendLog('Heartbeat', `[${accName}] -> ✅ 已回传 118 身份 (用户ID: ${this.loginInfo.userId})，在线状态已激活！`, 'success');

                  // 核心协议补全 1: 发送 Type 112 (CLINK_MSGC_MAIN_CLIENT_LOGIN_INFO) 会话凭据包
                  // 官方任务中心正是在此握手点记录终端正式连入云电脑会话并确认「登录AI云电脑」达成！
                  try {
                    const sId = desktopInfo.token || '';
                    const dType = this.deviceType ? String(this.deviceType) : '';
                    const dCode = this.account.deviceCode || '';
                    const uAcc = this.loginInfo.userName || '';

                    const sIdLen = Buffer.byteLength(sId, 'utf8') + 1;
                    const dTypeLen = Buffer.byteLength(dType, 'utf8') + 1;
                    const dCodeLen = Buffer.byteLength(dCode, 'utf8') + 1;
                    const uAccLen = Buffer.byteLength(uAcc, 'utf8') + 1;

                    const dataSize = 36 + sIdLen + dTypeLen + dCodeLen + uAccLen;
                    const dataBuf = Buffer.alloc(dataSize);
                    let offset = 0;
                    let strOffset = 36;

                    dataBuf.writeUInt32LE(Number(desktopId), offset); offset += 4;
                    dataBuf.writeUInt32LE(sIdLen, offset); offset += 4;
                    dataBuf.writeUInt32LE(strOffset, offset); offset += 4; strOffset += sIdLen;
                    dataBuf.writeUInt32LE(dTypeLen, offset); offset += 4;
                    dataBuf.writeUInt32LE(strOffset, offset); offset += 4; strOffset += dTypeLen;
                    dataBuf.writeUInt32LE(dCodeLen, offset); offset += 4;
                    dataBuf.writeUInt32LE(strOffset, offset); offset += 4; strOffset += dCodeLen;
                    dataBuf.writeUInt32LE(uAccLen, offset); offset += 4;
                    dataBuf.writeUInt32LE(strOffset, offset); offset += 4; strOffset += uAccLen;

                    dataBuf.write(sId, offset, 'utf8'); offset += sIdLen;
                    dataBuf.write(dType, offset, 'utf8'); offset += dTypeLen;
                    dataBuf.write(dCode, offset, 'utf8'); offset += dCodeLen;
                    dataBuf.write(uAcc, offset, 'utf8'); offset += uAccLen;

                    const msgBuf112 = Buffer.alloc(6 + dataSize);
                    msgBuf112.writeUInt16LE(112, 0); // Type 112
                    msgBuf112.writeUInt32LE(dataSize, 2);
                    dataBuf.copy(msgBuf112, 6);

                    safeSend(msgBuf112);
                  } catch (e) {}

                  // 核心协议补全 2: 发送 Type 104 (CLINK_MSGC_MAIN_ATTACH_CHANNELS) 通道挂接就绪包
                  try {
                    const msgBuf104 = Buffer.alloc(6);
                    msgBuf104.writeUInt16LE(104, 0); // Type 104
                    msgBuf104.writeUInt32LE(0, 2);
                    safeSend(msgBuf104);
                  } catch (e) {}

                  // 核心协议补全 3: 启动定时 Type 7 (CLINK_MSGC_HEARTBEAT) 双向心跳维持
                  // 天翼云网关据此计算活跃持续在线秒数，平滑累加挂机 1 小时 (3600秒) 时长！
                  if (this.clinkPingTimer) clearInterval(this.clinkPingTimer);
                  this.clinkPingTimer = setInterval(() => {
                    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                      const hbBuf = Buffer.alloc(6);
                      hbBuf.writeUInt16LE(7, 0); // Type 7
                      hbBuf.writeUInt32LE(0, 2);
                      safeSend(hbBuf);
                    }
                  }, 5000);

                  // 刷新官方任务与积分进度
                  setTimeout(() => this.refreshOfficialTasks(), 2500);
                }
              }
            } catch (err) {
              appendLog('Heartbeat', `[${accName}] 解析报文异常: ${err.message}`, 'warning');
            }
          });

          this.ws.on('error', (err) => {
            appendLog('Heartbeat', `[${accName}] 通道异常: ${err.message || '连接受阻'}`, 'error');
            this.metrics.errorCount++;
            endSession('Socket Error');
          });

          this.ws.on('close', (code, reason) => {
            appendLog('Heartbeat', `[${accName}] 保活长连接正常关闭 (${code} - ${reason || '正常轮转'})`, 'info');
            endSession('Closed');
          });
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
  } else {
    clientInstances.get(acc.id).account = acc;
  }
  return clientInstances.get(acc.id);
}

function initAllKeepAlive() {
  for (const acc of appConfig.accounts) {
    if (acc.enabled && acc.features?.keepAlive === true) {
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
  sendNotification: (settings, title, content) => sendNotification(settings, title, content),
  saveConfig: () => saveConfig(appConfig)
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
  if (session) {
    session.token = token;
  }
  return session;
}

// 缓存与代理天翼云电脑官方 Web 资产与模板
const ctyunStaticCache = new Map();
let cachedCtyunIndexHtml = '';
let cachedCtyunIndexTime = 0;

async function getCtyunIndexHtml() {
  const now = Date.now();
  if (cachedCtyunIndexHtml && (now - cachedCtyunIndexTime < 3600 * 1000)) {
    return cachedCtyunIndexHtml;
  }
  try {
    const res = await fetch('https://pc.ctyun.cn/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0'
      }
    });
    if (res.ok) {
      cachedCtyunIndexHtml = await res.text();
      cachedCtyunIndexTime = now;
      return cachedCtyunIndexHtml;
    }
  } catch (e) {
    console.error('Failed to fetch pc.ctyun.cn index:', e.message);
  }
  return cachedCtyunIndexHtml || '<!doctype html><html><head><title>天翼量子AI云电脑</title></head><body><div id="app"></div></body></html>';
}

async function proxyStaticAsset(res, targetUrl) {
  if (ctyunStaticCache.has(targetUrl)) {
    const cached = ctyunStaticCache.get(targetUrl);
    res.writeHead(200, {
      'Content-Type': cached.contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400'
    });
    res.end(cached.buffer);
    return;
  }

  try {
    const upstreamRes = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0',
        'Referer': 'https://pc.ctyun.cn/'
      }
    });
    if (!upstreamRes.ok) {
      res.writeHead(upstreamRes.status, { 'Content-Type': 'text/plain' });
      res.end('Upstream error: ' + upstreamRes.status);
      return;
    }
    const arrayBuf = await upstreamRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    let contentType = upstreamRes.headers.get('content-type') || 'application/octet-stream';
    if (targetUrl.endsWith('.wasm')) contentType = 'application/wasm';
    else if (targetUrl.endsWith('.js')) contentType = 'application/javascript; charset=utf-8';
    else if (targetUrl.endsWith('.css')) contentType = 'text/css; charset=utf-8';
    else if (targetUrl.endsWith('.png')) contentType = 'image/png';
    else if (targetUrl.endsWith('.ico')) contentType = 'image/x-icon';

    if (buffer.length < 20 * 1024 * 1024) {
      ctyunStaticCache.set(targetUrl, { buffer, contentType });
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400'
    });
    res.end(buffer);
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Failed to proxy static asset: ' + err.message);
  }
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

  // 云电脑 Web 免密直通网关视图 (直接打开操作界面，预置鉴权凭据与锁定 2560x1440 @ 150% 分辨率)
  if (pathname === '/desktop-view') {
    const session = getSessionFromReq(req, parsedUrl);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h3 style="font-family:sans-serif;padding:20px;">未授权：请先在仪表盘登录后再访问云电脑</h3>');
      return;
    }

    const accId = parsedUrl.searchParams.get('accId');
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h3 style="font-family:sans-serif;padding:20px;">云电脑账号不存在</h3>');
      return;
    }

    if (!canUserAccessAccount(session, acc)) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h3 style="font-family:sans-serif;padding:20px;">权限不足：无权访问该云电脑</h3>');
      return;
    }

    const client = getClient(acc);
    try {
      if (!client.loginInfo) {
        await client.login();
      }
      const desktops = await client.getDesktops();
      if (!desktops || desktops.length === 0) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h3 style="font-family:sans-serif;padding:20px;">未检测到名下可用云电脑</h3>');
        return;
      }
      const desktop = desktops[0];
      const objId = desktop.objId || desktop.desktopId;
      const b64Id = Buffer.from(String(objId)).toString('base64');

      // 核心避让机制：用户准备打开浏览器独立操作云电脑，后台长连接保活自动断开让位
      // 杜绝“AI云电脑在其他地方登录，您已被强制下线”的互踢冲突！
      client.yieldToWebUser(60);

      const authDataObj = {
        logined: true,
        userId: client.loginInfo?.userId,
        userName: client.loginInfo?.userName,
        mobilephone: client.loginInfo?.mobilephone || acc.user,
        tenantId: client.loginInfo?.tenantId,
        secretKey: client.loginInfo?.secretKey,
        deviceType: client.deviceType,
        bondedDevice: true,
        commonLoginReqHeader: client.loginInfo?.commonLoginReqHeader || '',
        timestamp: Date.now()
      };

      let html = await getCtyunIndexHtml();

      const injectScript = `
<script>
(function() {
  // 1. 自动免密注入天翼官方认证凭据至 localStorage
  const authData = ${JSON.stringify(authDataObj)};
  const deviceCode = ${JSON.stringify(acc.deviceCode)};
  const expiredAt = ${JSON.stringify(String(Date.now() + 72 * 3600 * 1000))};
  try {
    localStorage.setItem('web_device_code', deviceCode);
    localStorage.setItem('authExpiredAt', expiredAt);
    localStorage.setItem('authData', JSON.stringify(authData));
    localStorage.setItem('loginAt', Date.now().toString());
  } catch (e) {
    console.error('Failed to set localStorage', e);
  }

  // 2. API 请求代理拦截器 (规避跨域与 Origin 防盗链)
  const proxyBase = '/api/ctyun-proxy?target=';
  function rewriteUrl(u) {
    if (!u || typeof u !== 'string') return u;
    if (u.startsWith(proxyBase)) return u;
    if (u.includes('.ctyun.cn:8810') || u.includes('.ctyun.cn:8816') || u.includes('-deskmgr.ctyun.cn')) {
      return proxyBase + encodeURIComponent(u);
    }
    return u;
  }

  const origFetch = window.fetch;
  window.fetch = function(resource, init) {
    if (typeof resource === 'string') {
      resource = rewriteUrl(resource);
    } else if (resource && resource.url) {
      const newUrl = rewriteUrl(resource.url);
      resource = new Request(newUrl, resource);
    }
    return origFetch.call(this, resource, init);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    url = rewriteUrl(url);
    return origOpen.call(this, method, url, ...args);
  };

  // 4. 路由直接锁定进入云电脑操作界面
  const targetHash = '#/desktop?id=' + ${JSON.stringify(encodeURIComponent(b64Id))};
  if (!window.location.hash || window.location.hash.includes('/login') || window.location.hash.includes('/desktop-list')) {
    window.location.hash = targetHash;
  }

  // 5. 拦截 Web Worker 构造函数，自动重定向至代理网关，确保 bbenc 解码器正常通信
  const OrigWorker = window.Worker;
  window.Worker = function(scriptUrl, options) {
    if (typeof scriptUrl === 'string' && scriptUrl.includes('bbenc.worker.js')) {
      scriptUrl = '/workers/bbenc.worker.js';
    }
    return new OrigWorker(scriptUrl, options);
  };

  // 6. 前台网页生命周期与心跳保活双向感知感知探针
  // 打开页面每 5 秒发送心跳证明用户正在操作；页面关闭/离开时立即通知后台恢复保活守护
  const accId = ${JSON.stringify(acc.id)};
  const token = ${JSON.stringify(session.token || '')};
  function sendWebHeartbeat() {
    fetch('/api/accounts/' + accId + '/web-active?token=' + encodeURIComponent(token), { method: 'POST' }).catch(() => {});
  }
  sendWebHeartbeat();
  const webHbTimer = setInterval(sendWebHeartbeat, 5000);

  window.addEventListener('beforeunload', function() {
    clearInterval(webHbTimer);
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/accounts/' + accId + '/web-close?token=' + encodeURIComponent(token));
    } else {
      fetch('/api/accounts/' + accId + '/web-close?token=' + encodeURIComponent(token), { method: 'POST', keepalive: true }).catch(() => {});
    }
  });
})();
</script>
`;

      html = html.replace('<head>', '<head><title>天翼云电脑 - ' + (acc.name || acc.user) + '</title>' + injectScript);
      html = html.replace(/src="static\//g, 'src="/ctyun-static/static/');
      html = html.replace(/src="\.\/static\//g, 'src="/ctyun-static/static/');
      html = html.replace(/href="\.\/static\//g, 'href="/ctyun-static/static/');
      html = html.replace(/href="\.\/manifest\.json"/g, 'href="/ctyun-static/manifest.json"');

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h3 style="font-family:sans-serif;padding:20px;">连接云电脑服务异常: ' + err.message + '</h3>');
    }
    return;
  }

  // 代理天翼云 Web Worker 解码器与组件 (解决“当前浏览器版本过低，无法正常显示画面”问题)
  if (pathname.startsWith('/workers/') || pathname.includes('bbenc.worker.js')) {
    const filename = pathname.split('/').pop() || 'bbenc.worker.js';
    const targetUrl = 'https://pc.ctyun.cn/workers/' + filename;
    await proxyStaticAsset(res, targetUrl);
    return;
  }

  // 代理天翼云 WASM 解码器组件
  if (pathname.includes('bbEncDecoder') || pathname.endsWith('.wasm')) {
    const filename = pathname.split('/').pop();
    const targetUrl = 'https://pc.ctyun.cn/static/common/' + filename;
    await proxyStaticAsset(res, targetUrl);
    return;
  }

  // 代理天翼云静态资源
  if (pathname.startsWith('/ctyun-static/')) {
    const relPath = pathname.substring(13).replace(/^\/+/, '');
    const targetUrl = 'https://pc.ctyun.cn/' + relPath;
    await proxyStaticAsset(res, targetUrl);
    return;
  }

  // 天翼云 API 反向代理通道 (附带官方 Origin/Referer 防盗链透传与 CORS 响应头)
  if (pathname === '/api/ctyun-proxy') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
      });
      res.end();
      return;
    }

    const targetUrl = parsedUrl.searchParams.get('target');
    if (!targetUrl) {
      jsonResponse(res, { error: 'Missing target' }, 400);
      return;
    }

    try {
      const parsedTarget = new URL(targetUrl);
      if (!parsedTarget.hostname.endsWith('.ctyun.cn')) {
        jsonResponse(res, { error: 'Invalid proxy target' }, 403);
        return;
      }

      const bodyChunks = [];
      req.on('data', chunk => bodyChunks.push(chunk));
      req.on('end', async () => {
        const bodyBuffer = Buffer.concat(bodyChunks);
        const outgoingHeaders = {};
        for (const [k, v] of Object.entries(req.headers)) {
          const lk = k.toLowerCase();
          if (lk === 'host' || lk === 'origin' || lk === 'referer' || lk === 'content-length') continue;
          outgoingHeaders[k] = v;
        }
        outgoingHeaders['host'] = parsedTarget.host;
        outgoingHeaders['origin'] = 'https://pc.ctyun.cn';
        outgoingHeaders['referer'] = 'https://pc.ctyun.cn/';
        if (bodyBuffer.length > 0) {
          outgoingHeaders['content-length'] = bodyBuffer.length;
        }

        const clientModule = parsedTarget.protocol === 'http:' ? http : https;
        const proxyReq = clientModule.request(targetUrl, {
          method: req.method,
          headers: outgoingHeaders,
          rejectUnauthorized: false
        }, proxyRes => {
          const respHeaders = {};
          for (const [k, v] of Object.entries(proxyRes.headers)) {
            if (k.toLowerCase() === 'set-cookie') continue;
            respHeaders[k] = v;
          }
          respHeaders['access-control-allow-origin'] = '*';
          respHeaders['access-control-allow-headers'] = '*';
          respHeaders['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';

          res.writeHead(proxyRes.statusCode, respHeaders);
          proxyRes.pipe(res);
        });

        proxyReq.on('error', err => {
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Proxy request failed: ' + err.message }));
        });

        if (bodyBuffer.length > 0) {
          proxyReq.write(bodyBuffer);
        }
        proxyReq.end();
      });
    } catch (e) {
      jsonResponse(res, { error: 'Malformed proxy request: ' + e.message }, 400);
    }
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
    if (fs.existsSync(file)) {
      let type = 'text/plain';
      if (rel.endsWith('.css')) type = 'text/css; charset=utf-8';
      else if (rel.endsWith('.js')) type = 'application/javascript; charset=utf-8';
      else if (rel.endsWith('.html')) type = 'text/html; charset=utf-8';
      serveStatic(res, file, type);
    } else {
      const targetUrl = 'https://pc.ctyun.cn' + pathname;
      await proxyStaticAsset(res, targetUrl);
    }
    return;
  }

  // 2. 实时日志 SSE 流与历史日志获取 (权限严格隔离：未登录完全不可看，普通用户仅看自己账号)
  if (pathname === '/api/logs' && req.method === 'GET') {
    const session = getSessionFromReq(req, parsedUrl);
    if (!session) {
      jsonResponse(res, []);
      return;
    }
    const filtered = logs.filter(l => canUserSeeLog(session, l)).slice(-200);
    jsonResponse(res, filtered);
    return;
  }

  // 一键清空持久化历史日志 API
  if (pathname === '/api/logs/clear' && req.method === 'POST') {
    const session = getSessionFromReq(req, parsedUrl);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }

    if (session.role === 'admin') {
      logs.length = 0;
    } else {
      // 普通用户只清除自身可见日志
      for (let i = logs.length - 1; i >= 0; i--) {
        if (canUserSeeLog(session, logs[i])) {
          logs.splice(i, 1);
        }
      }
    }

    appendLog('System', `用户 [${session.username}] 执行了一键清空历史日志`, 'info');
    jsonResponse(res, { success: true, message: '历史日志已彻底清空！' });
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
        let completedAt = '';
        if (t.name.includes('登录AI云电脑')) {
          completedAt = a.stats?.lastSignTime || '';
        } else if (t.name.includes('AI对话')) {
          completedAt = a.stats?.lastAiChatTime || '';
        } else if (t.name.includes('使用1小时')) {
          completedAt = a.stats?.lastHangTime || '';
        }

        const isDone = t.status === 2 || (t.total > 0 && t.current >= t.total);
        if (isDone) {
          const val = t.points || 100;
          accTodayPoints += val;
          completedTasks.push({
            name: t.name,
            points: val,
            completed: true,
            completedAt: completedAt || `${today} 08:00:00`
          });
        } else {
          completedTasks.push({
            name: t.name,
            points: 0,
            completed: false,
            progress: `${t.current}/${t.total}`,
            completedAt: ''
          });
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

    let userAccounts = appConfig.accounts;
    if (session.role !== 'admin') {
      userAccounts = appConfig.accounts.filter(a => a.ownerId === session.userId);
    }

    // 智能状态同步：确保运行态指标状态准确反映长连接和机器实际状态
    for (const acc of userAccounts) {
      const client = getClient(acc);
      if (acc.features?.keepAlive === false || acc.manualShutdown === true) {
        client.stopKeepAliveWorker();
        client.metrics.status = 'offline';
        client.metrics.cycleCountdown = client.metrics.keepAliveSeconds || 60;
      } else if (acc.enabled && acc.features?.keepAlive === true) {
        if (!client.workerRunning) {
          client.startKeepAliveWorker();
        }
        if (client.wsAlive) {
          client.metrics.status = 'online';
        }
      }
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

    // 用户在界面上明确手动开启了保活开关：解除 manualShutdown 关机阻断
    if (body.features && body.features.keepAlive === true) {
      acc.manualShutdown = false;
    }

    saveConfig(appConfig);
    appendLog('System', `已更新账号配置: ${acc.name}`, 'info');

    const client = getClient(acc);
    if (acc.enabled && acc.features?.keepAlive === true) {
      if (!client.workerRunning) client.startKeepAliveWorker();
    } else {
      client.stopKeepAliveWorker();
    }

    jsonResponse(res, acc);
    return;
  }

  // 10. 管理员手动触发全量定时调度流程 API (立即以当前开关状态跑一遍)
  if (req.method === 'POST' && pathname === '/api/scheduler/trigger') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }
    if (session.role !== 'admin') {
      jsonResponse(res, { error: '权限不足：仅管理员可手动触发全局调度流程' }, 403);
      return;
    }

    if (taskScheduler) {
      taskScheduler.runAllAccounts('manual_trigger');
      jsonResponse(res, { success: true, message: '全局定时任务流程已触发启动，请在控制台查看执行输出' });
    } else {
      jsonResponse(res, { error: '调度器实例未初始化' }, 500);
    }
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
        executeNativeSign(client, acc, (src, msg, lvl) => appendLog(src, `[${acc.name}] ${msg}`, lvl))
          .then(async () => {
            acc.stats.lastSignTime = now;
            saveConfig(appConfig);
            await client.refreshOfficialTasks();
            sendNotification(
              appConfig.settings,
              `✅ 登录打卡达成 - ${acc.name}`,
              `账号【${acc.name}】今日登录AI云电脑任务已完成，100 积分已到账！`
            );
          })
          .catch(err => appendLog('Sign', `[${acc.name}] 打卡执行异常: ${err.message}`, 'error'));

        jsonResponse(res, { message: `[${acc.name}] 打卡指令已下发，官方积分实时同步刷新` });
        return;

      } else if (taskType === 'aiChat') {
        executeNativeAiChat(client, acc, (src, msg, lvl) => appendLog(src, `[${acc.name}] ${msg}`, lvl))
          .then(async () => {
            acc.stats.lastAiChatTime = now;
            saveConfig(appConfig);
            await client.refreshOfficialTasks();
            sendNotification(
              appConfig.settings,
              `🤖 AI对话任务达成 - ${acc.name}`,
              `账号【${acc.name}】今日AI智能对话任务已完成，100 积分已入账！`
            );
          })
          .catch(err => appendLog('AIChat', `[${acc.name}] AI 对话任务异常: ${err.message}`, 'error'));

        jsonResponse(res, { message: `[${acc.name}] AI 智能对话已触发执行，已获取对应积分` });
        return;

      } else if (taskType === 'hang') {
        executeNativeHang(client, acc, (src, msg, lvl) => appendLog(src, `[${acc.name}] ${msg}`, lvl))
          .then(async () => {
            acc.stats.lastHangTime = now;
            saveConfig(appConfig);
            await client.refreshOfficialTasks();
          })
          .catch(err => appendLog('Hang', `[${acc.name}] 挂机守护异常: ${err.message}`, 'error'));

        jsonResponse(res, { message: `[${acc.name}] 云电脑长连接守护已就绪，正在持续累加挂机时长` });
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

  // 14. 前台网页操作云电脑生命周期与心跳探活接口
  if (req.method === 'POST' && pathname.startsWith('/api/accounts/') && pathname.endsWith('/web-active')) {
    const session = getSessionFromReq(req, parsedUrl);
    if (!session) {
      jsonResponse(res, { error: '未授权' }, 401);
      return;
    }
    const accId = pathname.split('/')[3];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (acc && canUserAccessAccount(session, acc)) {
      const client = getClient(acc);
      // 保持避让：只要前台网页还在打开操作，每次心跳刷新避让有效期 (延长 15 秒)
      client.yieldToWebUser(0.25);
      jsonResponse(res, { success: true, active: true });
    } else {
      jsonResponse(res, { error: '账号不存在或无权访问' }, 404);
    }
    return;
  }

  // 前台网页关闭时触发的恢复接口
  if (req.method === 'POST' && pathname.startsWith('/api/accounts/') && pathname.endsWith('/web-close')) {
    const session = getSessionFromReq(req, parsedUrl);
    if (!session) {
      jsonResponse(res, { error: '未授权' }, 401);
      return;
    }
    const accId = pathname.split('/')[3];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (acc && canUserAccessAccount(session, acc)) {
      const client = getClient(acc);
      client.resumeFromWebUser();
      jsonResponse(res, { success: true, resumed: true });
    } else {
      jsonResponse(res, { error: '账号不存在或无权访问' }, 404);
    }
    return;
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
      // 确保已登录并拿到天翼云认证凭据
      if (!client.loginInfo) {
        await client.login();
      }
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
      const sessionToken = getSessionFromReq(req)?.token || (parsedUrl.searchParams.get('token') || '');

      // 直通操作页面入口 URL (带授权 Token 和云电脑 ID)
      const directViewUrl = `/desktop-view?accId=${accId}&token=${encodeURIComponent(sessionToken || '')}`;

      // 构造免密直达认证包 (localStorage.authData + web_device_code + authExpiredAt)
      const authDataObj = {
        logined: true,
        userId: client.loginInfo?.userId,
        userName: client.loginInfo?.userName,
        mobilephone: client.loginInfo?.mobilephone || acc.user,
        tenantId: client.loginInfo?.tenantId,
        secretKey: client.loginInfo?.secretKey,
        deviceType: client.deviceType,
        bondedDevice: true,
        commonLoginReqHeader: client.loginInfo?.commonLoginReqHeader || '',
        timestamp: Date.now()
      };

      jsonResponse(res, {
        success: true,
        user: acc.user,
        password: acc.password,
        deviceCode: acc.deviceCode,
        authData: authDataObj,
        authExpiredAt: String(Date.now() + 72 * 3600 * 1000),
        targetUrl,
        directViewUrl,
        desktopUrl: `https://pc.ctyun.cn/#/desktop-list`,
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
      const actionLower = (action || '').toLowerCase();
      let desktopId = '';
      
      // 如果当前机器已处于关机状态，直接提取本地记录的 desktopId 进行开机，防止 getDesktops 过滤导致 400
      try {
        const desktops = await client.getDesktops();
        if (desktops && desktops.length > 0) {
          desktopId = desktops[0].objId || desktops[0].desktopId;
        }
      } catch (e) {}

      if (!desktopId) {
        desktopId = client.metrics.desktopId || acc.stats?.desktopId || '';
      }

      if (!desktopId && actionLower !== 'poweron') {
        jsonResponse(res, { error: '未检测到可用云电脑' }, 400);
        return;
      }

      const resPower = await client.controlPower(desktopId, action);
      if (resPower.success) {
        // 核心联动：如果是用户在电源管理主动关机，自动关闭保活开关并打上主动关机标记，彻底停止保活重连与离线自动唤醒！
        if (actionLower === 'shutdown' || actionLower === 'poweroff') {
          acc.features = acc.features || {};
          acc.features.keepAlive = false;
          acc.manualShutdown = true;
          acc.stats = acc.stats || {};
          acc.stats.keepAliveStatus = 'offline';
          saveConfig(appConfig);
          client.stopKeepAliveWorker();
          appendLog('System', `[${acc.name}] 用户主动关机，已自动关闭保活开关，机器将维持关机，杜绝自动唤醒开机。`, 'info');
        } else if (actionLower === 'poweron' || actionLower === 'start' || actionLower === 'awake') {
          // 用户在电源管理主动点开机：恢复保活开关与后台长连接，解除主动关机标记
          acc.features = acc.features || {};
          acc.features.keepAlive = true;
          acc.manualShutdown = false;
          acc.stats = acc.stats || {};
          acc.stats.keepAliveStatus = 'online';
          saveConfig(appConfig);
          client.startKeepAliveWorker();
          appendLog('System', `[${acc.name}] 用户主动开机，已自动恢复保活开关与长连接守护。`, 'info');
        }

        jsonResponse(res, { ...resPower, features: acc.features });
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
    appendLog('System', '全局设置已更新，定时调度与配置已即时热重载生效', 'info');

    // 联动热更新：重新装载定时调度器的触发时间点
    if (taskScheduler) {
      taskScheduler.scheduleNextRun();
      taskScheduler.checkStartupCatchup();
    }

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
      if (newAcc.features?.keepAlive === true) {
        client.startKeepAliveWorker();
      }
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
