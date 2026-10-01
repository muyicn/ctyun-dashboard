const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const dns = require('dns');

// 全局优先使用 IPv4，彻底根治 Docker 容器及宿主机双栈网络下因 IPv6 无外网网关导致的 10 秒超时假死
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

const WebSocket = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');
// The ws package does not apply HTTP(S)_PROXY environment variables itself.
const wsProxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
const wsProxyAgent = wsProxyUrl ? new HttpsProxyAgent(wsProxyUrl) : undefined;
const CtYunEncryption = require('./app/ctyun_encryption');
const { executeNativeAiChat, executeNativeSign, executeNativeHang } = require('./app/tasks/native_tasks');
const { AuthManager } = require('./app/auth_manager');
const { TaskScheduler } = require('./app/tasks/scheduler');
const { SohoClient } = require('./app/ydpc/soho_client');
const { performCagAuthHold } = require('./app/ydpc/cag_client');
const { YdpcClient } = require('./app/ydpc/ydpc_client');
const { EcloudClient, LOG_SOURCE: ECLOUD_LOG_SOURCE, INTERACTIVE_BRANCHES } = require('./app/ecloud/ecloud_client');
const { LogPersister } = require('./app/persist_log');

// 全局异常拦截看门狗 (确保守护服务长期稳定运行不宕机)
// 【2026-09-27 退出取证】现场：面板曾静默死亡一次（exit=1、stdout/stderr 零输出、
// 无 WER 记录、stderr 捕获已证实有效）⇒ 排除 JS 未捕获异常（handler 会吞且不退出）
// 与原生崩溃（会打印 FATAL）⇒ 系外部终止（当时 Defender 正在做安全智能更新）。
// 教训：进程自己死了却不留任何痕迹，违反本项目"退出绝不静默"原则。故补三件事：
//   ① 异常/拒绝除 console.error 外**同时落持久日志**（stderr 可能丢失，jsonl 一定在）；
//   ② 'exit' 钩子记录退出码（进程自杀/正常退出均可见）；
//   ③ SIGINT/SIGTERM 记录并优雅退出（被要求停止时也留证）。
process.on('uncaughtException', (err) => {
  console.error('[!] 系统未捕获异常已拦截 (常驻保障):', err?.message || err);
  try { appendLog('System', `⚠️ 未捕获异常已拦截（进程继续运行）: ${(err && err.message) || err}`, 'error'); } catch (e) { /* 日志不可用则仅 console */ }
});
process.on('unhandledRejection', (reason) => {
  console.error('[!] 系统未处理 Promise 拒绝已拦截:', reason?.message || reason);
  try { appendLog('System', `⚠️ 未处理 Promise 拒绝已拦截: ${(reason && reason.message) || reason}`, 'error'); } catch (e) { /* 同上 */ }
});
process.on('exit', (code) => {
  try {
    appendLog('System', `⚠️ 主进程即将退出 (code=${code})${code === 0 ? '' : ' —— 非零退出码，请对照上一条异常/信号日志'}`, code === 0 ? 'warning' : 'error');
  } catch (e) { /* 退出路径尽力而为 */ }
});
process.on('SIGINT', () => {
  try { appendLog('System', '收到 SIGINT (Ctrl+C)，主进程即将退出', 'warning'); } catch (e) { /* 同上 */ }
  process.exit(0);
});
process.on('SIGTERM', () => {
  try { appendLog('System', '收到 SIGTERM，主进程即将退出', 'warning'); } catch (e) { /* 同上 */ }
  process.exit(0);
});

const PORT = process.env.PORT || 8571;
const DATA_DIR = process.env.CTYUN_DATA_DIR || path.join(__dirname, 'data');
const STATIC_DIR = path.join(__dirname, 'app', 'static');
const CONFIG_FILE = path.join(DATA_DIR, 'app_config.json');
const ACCOUNTS_JSON = path.join(DATA_DIR, 'accounts.json');
const DEVICES_DIR = path.join(DATA_DIR, 'devices');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DEVICES_DIR)) fs.mkdirSync(DEVICES_DIR, { recursive: true });

// 运行日志落盘（按北京日期滚动，默认保留 7 天）。
// 为什么：日志原本只在内存 `logs` 数组里，服务重启即丢 —— 事后无法复盘
// "机器为何被关机、当时保活在不在跑"。落盘失败会自动降级为仅内存，绝不影响主流程。
const LOG_DIR = path.join(DATA_DIR, 'logs');
const BOOT_LOG_LINES = Math.max(0, parseInt(process.env.CTYUN_LOG_BOOT_LINES, 10) || 400);
const logPersister = new LogPersister({
  dir: LOG_DIR,
  retentionDays: parseInt(process.env.CTYUN_LOG_RETENTION_DAYS, 10) || 7,
  onError: (msg) => console.error(`[日志落盘] ${msg}`)
});
logPersister.init();

console.log('[*] 纯原生超轻量内核已启动 (纯 HTTP/WebSocket 协议直连，纯净无负担)');

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
  // 【2026-09-23】数据面保活的 progress 日志（progress hb_sent=... hb_recv=...）每 10s 一条、
  // 数字持续变化，需并入 routine 合并（只保留最新一条 + xN 计数）
  if (message.includes('progress hb_sent=')) return true;
  return message.includes('心跳') || message.includes('保活周期') || message.includes('保持长连接') || message.includes('长连接保活') || message.includes('发送保活') || message.includes('REDQ') || message.includes('103 认证') || message.includes('118 用户身份') || message.includes('118 身份');
}

/**
 * 折叠键归一化：把消息里的数字一律替换为 N。
 *
 * 【为什么需要 · 用户 2026-09-25】「progress hb_sent= 后面的不管咋变化，都属于同一种类型，
 * 不用重复日志，显示最新的，然后后面 x 几就行」。同一件事只有数字在变的日志还有很多
 * （移动公众的「累计 N 次」「累计 N 台成功」「在线时长 N小时N分N秒」），
 * 若按原文逐字比对，每一轮都会被判成"新消息"→ 每轮新增一行。
 */
function normalizeRoutineDigits(message) {
  return String(message).replace(/\d+/g, 'N');
}

/**
 * 例行日志分类：只有命中这些"周期性口头禅"的消息才允许跨条目折叠。
 * 不命中 → 返回 null，绝不参与折叠（保证异常/业务事件永不被合并掉）。
 */
const ROUTINE_MESSAGE_PATTERNS = [
  'progress hb_sent=',   // ZTE 数据面 / 控制面心跳指标（约每 10s 一条，数字必变）
  'progress slow=',      // SCG（深信服）数据面 hold 进度（约每 10s 一条，数字必变；display 状态变化会自然另起一条）
  'SCG 材料探测',         // SCG firm-auth 材料巡检（presence 布尔，材料状态变化时内容才会变）
  '账号态探针通过',        // 移动公众 L1 账号态探针
  '桌面登记成功',          // 移动公众 L2 桌面登记
  '分层巡检结果',          // 移动公众 L1/L2 汇总汇报
  '已同步桌面列表',        // 移动公众桌面同步
  '心跳', '保活周期', '保持长连接', '长连接保活', '发送保活',
  'REDQ', '103 认证', '118 用户身份', '118 身份',
];

/**
 * 计算"例行日志折叠键"：同 source + 同类型（去数字后文本一致）才得同一个键。
 * 键里**必带 source**，确保三平台日志各自成流、绝不互相折叠。
 */
function routineFoldKey(source, message) {
  if (!message) return null;
  const m = String(message);
  if (source === 'Heartbeat') return 'Heartbeat|' + normalizeRoutineDigits(m);
  for (const pattern of ROUTINE_MESSAGE_PATTERNS) {
    if (m.includes(pattern)) return source + '|' + normalizeRoutineDigits(m);
  }
  return null;
}

/**
 * 例行日志折叠索引：折叠键 → 内存里那一条日志对象。
 *
 * 【为什么不再用"向前扫 N 条" · 用户 2026-09-25 第六轮】
 * 原实现从数组末尾向前最多扫 300 条找同类条目。但一轮巡检里，多个账号的 progress / 心跳
 * 会插入成百上千条日志，一旦超过窗口，同类条目就**找不到上一轮那条** → 另起一条新的、
 * 从 x1 重新累计。真机回放里「分层巡检结果」被劈成 x190 + x37 两条，正是这个原因。
 * 改为按折叠键直接查表 ⇒ O(1) 命中上一轮那条，窗口大小不再影响正确性。
 */
const routineFoldIndex = new Map();

/** 折叠索引键：折叠键 + level + 账号（折叠键本身已含 source） */
function routineFoldIndexKey(foldKey, level, accountName) {
  return foldKey + '\u0000' + (level || 'info') + '\u0000' + (accountName || '');
}

// ---------------------------------------------------------------------------
// 【2026-09-26 用户要求】例行日志折叠计数（xN）按天清零
// ---------------------------------------------------------------------------
// 用户原话：「[ZTE样本主号] progress hb_sent=261 hb_recv=555 data=5 left=637sx4056
//            类似这样的日志，要按天清零，不然一直循环下去增加数量了。0点更新一下吧。」
//
// 折叠徽章 xN = "这条例行日志累计重复了多少次"，它此前只增不减（x4056 → x4057 …）。
// 现改为**按北京时间每天 0 点归 1**，当天内照旧累计 ⇒ 界面上的 xN 表示"今日重复次数"。
//   ① 只动**例行日志**（routineFoldKey 非空）——异常/业务条目一条都不许碰（取证红线）；
//   ② 只把 repeatCount 归 1，**不改文本、不删条目、不动磁盘原始流水**（落盘那 4000+ 条仍在）；
//   ③ 双保险：appendLog 惰性检查（进程休眠/重启后自动补上）+ 北京 0 点定时器（界面即时刷新）。
let routineFoldDay = getBeijingDateOnly();

/**
 * 跨天则把例行日志的折叠计数归 1。返回被重置的条目数（0 = 未跨天或无命中）。
 * @param {boolean} notify 是否经 SSE 立刻把归零后的条目推给前端（定时器路径用 true）。
 *   惰性路径传 false：紧接其后的那条新日志本来就会触发一次 SSE 更新，无需重复推送。
 */
function rolloverRoutineFoldCountsIfNeeded(notify) {
  const today = getBeijingDateOnly();
  if (today === routineFoldDay) return 0;
  routineFoldDay = today;
  let changed = 0;
  for (const entry of logs) {
    if (!entry || typeof entry.message !== 'string') continue;
    // ⚠️ 非例行日志（异常 / 业务事件）绝不触碰 —— 与折叠机制同一条红线
    if (!routineFoldKey(entry.source, entry.message)) continue;
    if ((entry.repeatCount || 1) <= 1) continue;
    entry.repeatCount = 1;
    changed++;
    if (!notify) continue;
    const payload = { ...entry, isUpdate: true };
    for (const client of sseClients) {
      try {
        if (canUserSeeLog(client.session, entry)) {
          client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      } catch (e) {
        sseClients.delete(client);
      }
    }
  }
  return changed;
}

/** 距下一个北京 0 点还有多少毫秒（北京无夏令时，恒 UTC+8，故可纯算术） */
function msUntilNextBeijingMidnight() {
  const OFFSET_MS = 8 * 3600 * 1000;
  const bj = Date.now() + OFFSET_MS;
  return (Math.floor(bj / 86400000) + 1) * 86400000 - bj;
}

/** 北京 0 点触发清零；**自续期**重排下一个 0 点（不做 while 轮询） */
function scheduleRoutineFoldDayRollover() {
  const timer = setTimeout(() => {
    try {
      rolloverRoutineFoldCountsIfNeeded(true);
    } catch (e) {
      // 日志维护出错绝不影响主流程，但必须留痕（不得空 catch）
      console.error(`[日志折叠] 跨天清零失败: ${e.message}`);
    }
    scheduleRoutineFoldDayRollover();
  }, msUntilNextBeijingMidnight());
  if (timer.unref) timer.unref();
}
scheduleRoutineFoldDayRollover();

// 自动日志清理维护定时器：每小时执行一次，自动清理超过 3 天的历史日志或多于 2000 条的数据
setInterval(() => {
  if (logs.length > 1500) {
    logs.splice(0, logs.length - 1000);
  }
}, 3600 * 1000);

/** 智能推断平台归属 */
function inferLogPlatform(source, platform) {
  if (source === 'SOHO' || source === 'CAG' || source === 'CSAP' || source === 'YDPc') return 'ydpc';
  // 移动公众（ecloud）走独立侧车，日志源固定为 ECLOUD —— 与移动爱家/天翼云的日志流严格分开
  if (source === ECLOUD_LOG_SOURCE || source === 'ECLOUD') return 'ecloud';
  if (source === 'Sign' || source === 'AIChat' || source === 'Hang' || source === 'Redeem') return 'ctyun';
  return platform || 'ctyun';
}

/** 构造一条原始日志条目（不做任何折叠） */
function buildLogEntry(source, message, level = 'info', accountName = '', platform = 'ctyun') {
  return {
    id: 'log_' + (++logIdCounter),
    timestamp: getBeijingTimeString(),
    source,
    message,
    level,
    accountName: accountName || '',
    platform: inferLogPlatform(source, platform),
    repeatCount: 1
  };
}

/**
 * 把一条日志并入内存日志流（重复项折叠为 xN + SSE 推送）。
 *
 * 【落盘与折叠的分工】磁盘上保留的是**原始流水**（每条 progress 心跳都在），
 * 本函数只负责内存/UI 侧的展示折叠 —— 取证信息不得因折叠而丢失。
 */
function ingestLogEntry(entry) {
  if (!entry || typeof entry.message !== 'string') return;
  const source = entry.source;
  const message = entry.message;
  const level = entry.level || 'info';
  const accountName = entry.accountName || '';
  const nowTime = entry.timestamp || getBeijingTimeString();

  // 全双工智能折叠机制：
  // 1. 同来源同内容的完全一致重复消息合并
  // 2. 心跳/周期性 routine 消息合并（只保留最新一条并叠加次数计数）

  // 【2026-09-25 用户要求·第四轮】例行日志按"折叠键"跨条目收敛。
  //
  // 旧实现只认 progress，且**遇到同 source 的非同类日志就中断向前搜索**（该逻辑已删除）。
  // 真机回放暴露了后果：一次保活里 progress 被"隧道建立 / 切片结束 / 心跳成功"等正常日志
  // 打断多次 → 每断一次就新起一条，各自累计 xN；内存里同源同账号的 progress 条目一度
  // 多达 21 条（x89 / x49 / x41 …），用户看到的正是"x11、x12、x13 … 一长串"。
  //
  // 现在改为：只要属于同类例行日志（routineFoldKey 相同），无论中间夹了什么、无论数字怎么变，
  // 一律并入**同一条** —— 只保留最新文本 + xN。异常与业务事件因 routineFoldKey 为 null
  // 而完全不参与折叠，取证信息一条不少。
  const foldKey = routineFoldKey(source, message);
  const foldIndexKey = foldKey ? routineFoldIndexKey(foldKey, level, accountName) : null;
  if (foldIndexKey) {
    const prev = routineFoldIndex.get(foldIndexKey);
    // 索引里可能是**已被淘汰出内存数组**的陈旧条目（数组有 2000 条上限），命中后先验明真身
    const at = prev ? logs.indexOf(prev) : -1;
    if (at !== -1) {
      prev.timestamp = nowTime;
      prev.message = message;
      prev.platform = entry.platform;
      prev.repeatCount = (prev.repeatCount || 1) + 1;
      // 【2026-09-24 用户要求·第三轮】折叠把该条目的时间戳推进到了"现在"，
      // 若仍留在原索引，历史回放会呈现"时间倒挂"（最新时间戳却排在中间）。
      // 因此把它移动到数组末尾 —— 保证 logs 恒为时间升序、最新一条永远在最后。
      if (at !== logs.length - 1) {
        logs.splice(at, 1);
        logs.push(prev);
      }
      const updatePayload = { ...prev, isUpdate: true };
      for (const client of sseClients) {
        try {
          if (canUserSeeLog(client.session, prev)) {
            client.res.write(`data: ${JSON.stringify(updatePayload)}\n\n`);
          }
        } catch (e) {
          sseClients.delete(client);
        }
      }
      return;
    }
    // 陈旧条目（已不在数组里）：清掉索引，等价于"本轮另起一条"
    if (prev) routineFoldIndex.delete(foldIndexKey);
  }

  // 【2026-09-25 第五轮】旧逻辑在这里还有一条「只看最后一条 + 只要两条都是例行就合并」
  // （isRoutinePair）的旁路。它有两个后果：
  //   ① 不同**类**的例行日志（progress hb_sent=… 与「心跳保持成功」）只要相邻就会互相折进去，
  //      把各自的 xN 搅在一起 —— 这正是「5 次心跳只累计出 x4」的根因；
  //   ② 它只看最后一条，跨条目场景必须靠上面的 routineFoldIndex 查表。
  // 现在例行日志的折叠**只认 routineFoldKey（键相同才合并）**；这里仅保留"完全同文本相邻重复"，
  // 用于非例行的连发重复（例如同一条错误连报两次），其判定不涉及任何"同源即兄弟"的宽松假设。
  if (logs.length > 0) {
    const last = logs[logs.length - 1];
    const sameAcc = (last.accountName || '') === (accountName || '');
    const sameSrc = last.source === source;
    const sameLvl = last.level === level;

    const isRepeat = sameAcc && sameSrc && sameLvl && last.message === message;

    if (isRepeat) {
      last.timestamp = nowTime;
      last.message = message;
      last.platform = entry.platform;
      last.repeatCount = (last.repeatCount || 1) + 1;
      // 这条"完全同文本"的重复若也属例行日志，顺手登记进折叠索引，
      // 免得下一轮心跳因为"索引里查不到"而另起一条。
      if (foldIndexKey) routineFoldIndex.set(foldIndexKey, last);

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
  logs.push(entry);
  // 例行日志登记进折叠索引：下一轮同类消息将直接命中它，不再依赖"向前扫 N 条"
  if (foldIndexKey) routineFoldIndex.set(foldIndexKey, entry);
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

/**
 * 记录一条日志。
 *
 * 【顺序很重要】先落盘、后折叠：
 *   磁盘上留的是**原始流水**（例如数据面 progress 每 10s 一条全部保留），
 *   内存里则折叠成一条 + xN 供界面展示。这样既能"事后取证"，界面又不会被刷屏。
 *   历史教训：日志只在内存里时，服务一重启就无法复盘"关机那一刻保活在不在跑"。
 */
function appendLog(source, message, level = 'info', accountName = '', platform = 'ctyun') {
  // 【2026-09-26】跨天则**先把例行日志的折叠计数归零**，再落这条新日志 ——
  // 保证"昨天那条"的 xN 不会在跨天后的第一条上被加成 x(N+1)（进程休眠/重启后靠这里补上）。
  rolloverRoutineFoldCountsIfNeeded(false);
  const entry = buildLogEntry(source, message, level, accountName, platform);
  logPersister.append(entry);
  ingestLogEntry(entry);
}

/**
 * 启动时从磁盘回灌最近的日志到内存，使服务重启后控制台不至于空白。
 * 回灌只走 ingestLogEntry（折叠 + 入内存），**不再回写磁盘**，避免自我复制。
 */
function bootstrapLogsFromDisk() {
  if (BOOT_LOG_LINES <= 0) return 0;
  let rows = [];
  try {
    rows = logPersister.loadRecent(BOOT_LOG_LINES);
  } catch (e) {
    console.error(`[日志落盘] 启动回灌失败: ${e.message}`);
    return 0;
  }
  for (const row of rows) {
    ingestLogEntry({
      id: 'log_' + (++logIdCounter),
      timestamp: row.timestamp || getBeijingTimeString(),
      source: row.source || 'System',
      message: row.message || '',
      level: row.level || 'info',
      accountName: row.accountName || '',
      platform: row.platform || 'ctyun',
      repeatCount: Math.max(1, parseInt(row.repeatCount, 10) || 1)
    });
  }
  return rows.length;
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

// 带超时保护的网络请求 (防止天翼云网关偶发挂起导致保活循环永久阻塞)
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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

function isValidWebhookTarget(channel, rawTarget) {
  if (!rawTarget || typeof rawTarget !== 'string') return false;
  const target = rawTarget.trim();
  if (!target) return false;

  const ch = channel || 'webhook';
  // Token 型推送渠道 (向平台官方公共 API 发送请求)
  if (ch === 'serverchan' || ch === 'pushplus') {
    return /^[\w\-]{6,128}$/.test(target);
  }
  if (ch === 'telegram') {
    // 格式 botToken@chatId
    return /^[\w\-:]+@[\w\-]+$/.test(target);
  }

  // 钉钉支持输入纯 access_token (32~128位字符)
  if (ch === 'dingtalk' && /^[a-zA-Z0-9_\-]{32,128}$/.test(target)) {
    return true;
  }

  // URL 型推送渠道 (webhook, qywx, dingtalk, feishu, bark)
  try {
    // 剥离可能附带的 @SEC... 密钥后缀以供 URL 校验
    const checkUrl = target.split('@SEC')[0].trim();
    const u = new URL(checkUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (isPrivateIpOrHost(u.hostname)) return false;
    return true;
  } catch (e) {
    return false;
  }
}

function isValidWebhookUrl(rawUrl) {
  return isValidWebhookTarget('webhook', rawUrl);
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

  // SSRF 安全防御与有效性校验
  if (notify.webhookUrl && !isValidWebhookTarget(channel, notify.webhookUrl)) {
    appendLog('Notify', `[安全拦截] 拒绝向私有/内网或非法协议地址发送 Webhook: ${notify.webhookUrl}`, 'error');
    return { success: false, message: '安全拦截：禁止向内网/本地私有地址或非法格式发送推送' };
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
    } else if (channel === 'dingtalk' && notify.webhookUrl) {
      let dingUrl = notify.webhookUrl.trim();
      let dingSecret = (notify.secret || '').trim();

      // 1. 如果用户输入的是纯 access_token，自动补全官方 Webhook 基础前缀
      if (/^[a-zA-Z0-9_\-]{32,128}$/.test(dingUrl)) {
        dingUrl = `https://oapi.dingtalk.com/robot/send?access_token=${dingUrl}`;
      }

      // 2. 支持从 URL 中智能提取加签密钥: 如 https://oapi.dingtalk.com/robot/send?access_token=xxx&secret=SECxxx 或 url@SECxxx
      if (dingUrl.includes('@SEC')) {
        const parts = dingUrl.split('@');
        dingUrl = parts[0].trim();
        dingSecret = dingSecret || parts[1].trim();
      } else if (dingUrl.includes('secret=')) {
        try {
          const u = new URL(dingUrl);
          const s = u.searchParams.get('secret');
          if (s) {
            dingSecret = dingSecret || s;
            u.searchParams.delete('secret');
            dingUrl = u.toString();
          }
        } catch (e) {}
      }

      // 3. 如果开启或提供了加签密钥 (SEC...)，严格按照钉钉官方标准计算 HmacSHA256 签名并追加到 URL
      if (dingSecret) {
        const timestamp = Date.now();
        const stringToSign = `${timestamp}\n${dingSecret}`;
        const sign = crypto.createHmac('sha256', dingSecret).update(stringToSign).digest('base64');
        const sep = dingUrl.includes('?') ? '&' : '?';
        dingUrl = `${dingUrl}${sep}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
      }

      // 4. 钉钉 Markdown 负载 (首屏 title 必须为纯文本，剔除特殊字符)
      const cleanTitle = finalTitle.replace(/[#*`_~\[\]()]/g, '').trim() || '云电脑通知';
      const dingPayload = {
        msgtype: 'markdown',
        markdown: {
          title: cleanTitle,
          text: `### ${finalTitle}\n\n${finalContent}\n\n> 触发时间: ${vars['{time}']}`
        }
      };
      const res = await fetch(dingUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dingPayload)
      });
      const dingData = await res.json().catch(() => ({}));
      let errMsg = dingData.errmsg || `HTTP ${res.status}`;
      if (dingData.errcode === 310000) {
        if (errMsg.includes('sign not match')) {
          errMsg = '【加签校验失败】您的钉钉机器人开启了加签安全设置，请在设置中填写以 SEC 开头的加签密钥 (Secret)！';
        } else if (errMsg.includes('keywords not in content')) {
          errMsg = '【关键词不匹配】您的钉钉机器人设置了自定义关键词，通知内容中必须包含您在钉钉设定的关键词！';
        } else if (errMsg.includes('IP')) {
          errMsg = '【IP未在白名单】您的钉钉机器人设置了IP白名单，当前服务器IP未在白名单中！';
        }
      } else if (dingData.errcode === 300001) {
        errMsg = '【Token无效】钉钉 access_token 无效或机器人已被删除，请核对 Webhook 地址！';
      }
      return { success: res.ok && dingData.errcode === 0, message: errMsg };
    } else if (channel === 'feishu' && notify.webhookUrl) {
      let feishuUrl = notify.webhookUrl.trim();
      let feishuSecret = (notify.secret || '').trim();

      // 支持从 URL 提取 secret: url@secret
      if (feishuUrl.includes('@')) {
        const parts = feishuUrl.split('@');
        feishuUrl = parts[0].trim();
        feishuSecret = feishuSecret || parts[1].trim();
      }

      const feishuPayload = {
        msg_type: 'interactive',
        card: {
          header: {
            title: {
              tag: 'plain_text',
              content: finalTitle
            },
            template: 'blue'
          },
          elements: [
            {
              tag: 'div',
              text: {
                tag: 'lark_md',
                content: `${finalContent}\n\n**触发时间**: ${vars['{time}']}`
              }
            }
          ]
        }
      };

      if (feishuSecret) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const stringToSign = `${timestamp}\n${feishuSecret}`;
        const sign = crypto.createHmac('sha256', stringToSign).update('').digest('base64');
        feishuPayload.timestamp = timestamp;
        feishuPayload.sign = sign;
      }
      const res = await fetch(notify.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(feishuPayload)
      });
      const feishuData = await res.json().catch(() => ({}));
      const isOk = res.ok && (feishuData.code === 0 || feishuData.StatusCode === 0 || feishuData.code === undefined);
      return { success: isOk, message: feishuData.msg || feishuData.StatusMessage || `HTTP ${res.status}` };
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

// 针对特定账号的定向通知分发（优先使用云电脑所属用户的专属 Webhook，未配置或系统级事件兜底使用管理员/系统通知）
async function sendAccountNotification(account, title, content, extraVars = {}) {
  try {
    const ownerId = account?.ownerId || 'u_admin';
    const owner = (appConfig.users || []).find(u => u.id === ownerId);
    let targetNotify = owner?.notify;

    // 若用户未配置且所属用户为 admin，允许回退到 appConfig.settings?.notify（向下兼容）
    if (!targetNotify || !targetNotify.enabled) {
      if (owner?.role === 'admin' && appConfig.settings?.notify?.enabled) {
        targetNotify = appConfig.settings.notify;
      }
    }

    if (targetNotify && targetNotify.enabled) {
      return await sendNotification(
        { notify: targetNotify },
        title,
        content,
        { ...extraVars, account: account?.name || account?.user || extraVars.account || '云电脑' }
      );
    }
    return { success: false, message: '该账号所属用户未开启消息推送' };
  } catch (err) {
    appendLog('Notify', `定向推送发生异常(已安全隔离): ${err.message}`, 'warning');
    return { success: false, message: err.message };
  }
}

// 双平台通用原子文件写入函数 (防断电/防崩溃截断：先写临时文件再原子重命名替换)
function atomicWriteFileSync(filePath, content, encoding = 'utf8', mode = undefined) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 7)}`);
  const opts = mode ? { encoding, mode } : { encoding };
  fs.writeFileSync(tmpPath, content, opts);
  try {
    try {
      fs.renameSync(tmpPath, filePath);
    } catch (renameErr) {
      // Windows 平台在文件占用瞬间 renameSync 可能抛 EPERM，回退为 copyFileSync 替换后清理临时文件
      fs.copyFileSync(tmpPath, filePath);
      try { fs.unlinkSync(tmpPath); } catch (e) {}
    }
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
    throw err;
  }
}

// AES-256-GCM 密码强加密与安全落盘 (支持主密钥与备份密钥双重容灾互保)
const MASTER_KEY_FILE = path.join(DATA_DIR, '.master.key');
const MASTER_KEY_BAK_FILE = path.join(DATA_DIR, '.master.key.bak');

function getOrCreateMasterKey() {
  // 1. 优先从主密钥文件读取
  if (fs.existsSync(MASTER_KEY_FILE)) {
    try {
      const raw = fs.readFileSync(MASTER_KEY_FILE, 'utf8').trim();
      if (raw.length === 64) {
        // 同步刷新备份密钥
        try { atomicWriteFileSync(MASTER_KEY_BAK_FILE, raw, 'utf8', 0o600); } catch (e) {}
        return Buffer.from(raw, 'hex');
      }
    } catch (e) {}
  }

  // 2. 主密钥损坏或丢失时，自动从备份密钥恢复
  if (fs.existsSync(MASTER_KEY_BAK_FILE)) {
    try {
      const raw = fs.readFileSync(MASTER_KEY_BAK_FILE, 'utf8').trim();
      if (raw.length === 64) {
        try { atomicWriteFileSync(MASTER_KEY_FILE, raw, 'utf8', 0o600); } catch (e) {}
        console.log('🛡️ [安全自愈] 主密钥文件异常，已成功从备份密钥 (.master.key.bak) 恢复！');
        return Buffer.from(raw, 'hex');
      }
    } catch (e) {}
  }

  // 3. 首次全新初始化：生成 32 字节主密钥并双写持久化
  const newKey = crypto.randomBytes(32);
  const hexKey = newKey.toString('hex');
  try {
    atomicWriteFileSync(MASTER_KEY_FILE, hexKey, 'utf8', 0o600);
    atomicWriteFileSync(MASTER_KEY_BAK_FILE, hexKey, 'utf8', 0o600);
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
      pulseIntervalSeconds: 30,
      allowRegistration: false, // 默认不开放注册，必须由管理员后台手动开启
      defaultQuota: 2,         // 普通用户默认配额 2 台
      cron: {
        executeTime: '01:20',
        enableSubCron: false,
        signCron: '0 2 * * *',
        aiChatCron: '0 3,20 * * *',
        cloudHangCron: '0 4,6 * * *',
        redeemCron: '0 7 * * *'
      },
      notify: {
        enabled: false,
        channel: 'webhook',
        webhookUrl: ''
      },
      systemTitle: '天翼云/移动云电脑保活签到中心',
      systemSubtitle: '多账号长连接保活守护 · 多运营商支持 · 每日签到打卡 · 智能挂机'
    },
    users: [],
    accounts: []
  };
}

function loadConfig() {
  const BAK_FILE = CONFIG_FILE + '.bak';
  let cfg = null;
  let loadedFromBak = false;

  // 1. 尝试从主配置文件加载
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const content = fs.readFileSync(CONFIG_FILE, 'utf8').trim();
      if (content) {
        cfg = JSON.parse(content);
      } else {
        console.warn('⚠️ [配置检查] 主配置文件 app_config.json 为空 (0 字节)');
      }
    } catch (e) {
      console.error('⚠️ [配置损坏] 主配置文件 app_config.json 解析失败:', e.message);
      // 保护现场：绝不直接销毁损坏文件！
      try {
        const corruptBak = path.join(DATA_DIR, `app_config.corrupt.${Date.now()}.json`);
        fs.copyFileSync(CONFIG_FILE, corruptBak);
        console.warn(`⚠️ [安全保护] 已将损坏的配置现场安全备份至: ${corruptBak}`);
      } catch (err) {}
    }
  }

  // 2. 如果主配置损坏、为空或关键数据结构缺失，尝试从自动备份文件 .bak 恢复！
  if ((!cfg || (!Array.isArray(cfg.users) && !Array.isArray(cfg.accounts))) && fs.existsSync(BAK_FILE)) {
    try {
      const bakContent = fs.readFileSync(BAK_FILE, 'utf8').trim();
      if (bakContent) {
        const bakCfg = JSON.parse(bakContent);
        if (bakCfg && (Array.isArray(bakCfg.users) || Array.isArray(bakCfg.accounts))) {
          cfg = bakCfg;
          loadedFromBak = true;
          console.log('🛡️ [容灾自愈] 检测到主配置异常，已成功从自动备份文件 (app_config.json.bak) 完美恢复全量配置！');
        }
      }
    } catch (e) {
      console.error('读取备份配置文件失败:', e);
    }
  }

  // 3. 如果成功获取到配置 (无论是主配置还是备份恢复)
  if (cfg && (cfg.settings || cfg.accounts || cfg.users)) {
    const defaultSettings = getDefaultConfig().settings;
    if (!cfg.settings) {
      cfg.settings = defaultSettings;
    } else {
      cfg.settings = { ...defaultSettings, ...cfg.settings };
    }
    if (!Array.isArray(cfg.accounts)) cfg.accounts = [];
    if (!Array.isArray(cfg.users)) cfg.users = [];

    // 兼容历史版本：将 settings.notify 自动无损同步至 admin 账号作为其私有通知，保证已有配置不丢失
    if (cfg.settings?.notify && cfg.settings.notify.enabled) {
      const adminUser = cfg.users.find(u => u.username === 'admin' || u.role === 'admin');
      if (adminUser && !adminUser.notify) {
        adminUser.notify = { ...cfg.settings.notify };
      }
    }
    // 默认已有账号归属 admin，默认平台为 ctyun，并解密密码还原至内存
    cfg.accounts.forEach(a => {
      if (!a.ownerId) a.ownerId = 'u_admin';
      if (!a.platform) a.platform = 'ctyun';
      if (a.password) a.password = decryptPassword(a.password);
    });

    // 如果是从备份恢复的，立即原子回写主配置文件修复现场
    if (loadedFromBak) {
      saveConfig(cfg);
    } else {
      // 主配置正常，原子同步刷新备份文件
      try {
        const diskClone = JSON.parse(JSON.stringify(cfg));
        if (Array.isArray(diskClone.accounts)) {
          for (const a of diskClone.accounts) {
            if (a.password) a.password = encryptPassword(a.password);
          }
        }
        atomicWriteFileSync(BAK_FILE, JSON.stringify(diskClone, null, 2), 'utf8');
      } catch (e) {}
    }
    return cfg;
  }

  // 4. 只有在首次全新安装时（既无主配置，也无备份），才初始化默认配置
  console.log('ℹ️ [系统初始化] 未检测到已有配置文件，正在初始化全新运行环境...');
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

    const jsonStr = JSON.stringify(diskClone, null, 2);
    // 1. 原子写入主配置文件 (防崩溃/防断电截断)
    atomicWriteFileSync(CONFIG_FILE, jsonStr, 'utf8');

    // 2. 自动同步持久化备份文件 (app_config.json.bak)
    if (Array.isArray(diskClone.accounts) || Array.isArray(diskClone.users)) {
      try {
        const BAK_FILE = CONFIG_FILE + '.bak';
        atomicWriteFileSync(BAK_FILE, jsonStr, 'utf8');
      } catch (e) {}
    }

    // 3. accounts.json 同样加密保护并原子写入
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
    atomicWriteFileSync(ACCOUNTS_JSON, JSON.stringify(ctyunJson, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('保存配置失败:', e);
    return false;
  }
}

let appConfig = loadConfig();

// 初始化多用户管理器
// 【2026-09-28】"30 天内免登录"的落盘存储：只有勾选免登录的会话会写这里（原子写 + 0600），
// 容器重启后由 AuthManager.restoreSessions() 恢复 —— 在此之前会话是纯内存，重启即全丢。
const AUTH_SESSIONS_FILE = path.join(DATA_DIR, 'auth_sessions.json');
const authSessionStore = {
  load: () => {
    try { return JSON.parse(fs.readFileSync(AUTH_SESSIONS_FILE, 'utf8')); } catch (e) { return null; }
  },
  save: (obj) => {
    try {
      // 空表直接删除文件，避免残留空壳；写入失败必须静默降级（绝不因会话落盘失败拖垮登录）
      if (!obj || Object.keys(obj).length === 0) {
        if (fs.existsSync(AUTH_SESSIONS_FILE)) fs.unlinkSync(AUTH_SESSIONS_FILE);
        return;
      }
      atomicWriteFileSync(AUTH_SESSIONS_FILE, JSON.stringify(obj, null, 2), 'utf8', 0o600);
    } catch (e) { /* 磁盘不可写时仅内存生效 */ }
  }
};
const authManager = new AuthManager({
  get config() { return appConfig; },
  saveConfig: () => saveConfig(appConfig),
  sessionStore: authSessionStore
});

// ==========================================================
// 开关语义的单一权威入口 (暗线 A 的结构性修复)
// ----------------------------------------------------------
// 历史缺陷：keepaliveEnabled / taskEnabled / cloudHang / autoBootEnabled 四个字段
// 在多处被各自读取、语义互相渗透，导致同一个耦合在 2026-09-14 与 2026-09-21
// 被两次宣称"彻底解耦"却两次复发。
// 现在规定：
//   - 保活 (keepAlive) 只由 keepAlive + desktop.keepaliveEnabled 决定；
//   - 任务 (sign / aiChat / cloudHang) 只由 features.<task> + desktop.taskEnabled 决定；
//   - autoBoot 只决定"是否代为开机"，不参与任何"任务是否执行"的判定。
//     （移动云侧的开机守护有独立口径，见 ydpc_client.js 的 _autoBootArmed；此处仅对天翼云 desktop 仍成立。）
// 任何判定点都必须调用本函数，不得再就地读取原始字段。
// ==========================================================
const TASK_CN_NAME = {
  keepAlive: '常态保活', sign: '登录打卡', aiChat: 'AI 对话', cloudHang: '1 小时挂机',
  // 移动公众（ecloud）：分层保活，各自独立开关
  // 【2026-09-26 用户拍板】L3（SPICE 心跳）从未实现，整层删除（UI 到底层）—— 只保留 L1/L2。
  ecloudL1AccountKeep: 'L1 账号态保活', ecloudL2DesktopReg: 'L2 桌面登记保活'
};

// 【字段名映射 · 本次源审新发现 #43】历史代码里"登录打卡"的账号级开关字段名是
// autoSign（前端 toggleFeature('...','autoSign')、默认值 {keepAlive,autoSign,aiChat,cloudHang,autoRedeem}、
// 备份迁移判断都用 autoSign），而"任务类型常量"叫 'sign'。二者不一致。
// 若直接用 f[taskType] 去读，'sign' 会永远命中 undefined，导致"账号级打卡开关"彻底失效 ——
// 用户关掉打卡开关后任务仍会执行，正是"开关不起作用"类投诉的又一根源。
// 因此此处显式建立 任务类型 -> 功能字段 的映射，杜绝名称漂移。
const TASK_FEATURE_KEY = {
  keepAlive: 'keepAlive', sign: 'autoSign', aiChat: 'aiChat', cloudHang: 'cloudHang',
  // 移动公众（ecloud）分层保活：任务类型名与账号级字段名一一对应，杜绝名称漂移。
  ecloudL1AccountKeep: 'ecloudL1AccountKeep',
  ecloudL2DesktopReg: 'ecloudL2DesktopReg'
};

// 移动公众的这两层属于【保活类】而非【任务类】：单机维度看的是 keepaliveEnabled
// （与 taskEnabled 语义无关）。把它们显式列出，避免被通用分支错误地按 taskEnabled 判定。
const ECLOUD_KEEPALIVE_TASKS = new Set(['ecloudL1AccountKeep', 'ecloudL2DesktopReg']);

function resolveTaskEnabled(account, desktop, taskType) {
  const label = TASK_CN_NAME[taskType] || taskType;
  if (!account) return { enabled: false, reason: '账号不存在' };
  if (account.enabled === false) return { enabled: false, reason: '账号已停用' };

  const f = account.features || {};
  const featureKey = TASK_FEATURE_KEY[taskType] || taskType;

  if (taskType === 'keepAlive') {
    if (f.keepAlive === false) return { enabled: false, reason: '账号级【常态保活】开关已关闭' };
    if (desktop && desktop.keepaliveEnabled === false) return { enabled: false, reason: '该云电脑的【独立保活】开关已关闭' };
    return { enabled: true, reason: '' };
  }

  // 移动公众（ecloud）：三层保活同属"保活类" —— 账号级开关 + 单机 keepaliveEnabled，
  // 与 taskEnabled 无关（混用会让"关掉任务开关"误停保活）。
  if (ECLOUD_KEEPALIVE_TASKS.has(taskType)) {
    if (f[featureKey] === false) return { enabled: false, reason: `账号级【${label}】开关已关闭` };
    if (desktop && desktop.keepaliveEnabled === false) return { enabled: false, reason: '该云电脑的【独立保活】开关已关闭' };
    return { enabled: true, reason: '' };
  }

  // 所有"任务类"开关一致：只看账号级任务开关与该机任务开关，
  // 保活开关 (keepAlive / keepaliveEnabled) 对任务是否执行【零影响】。
  if (f[featureKey] === false) return { enabled: false, reason: `账号级【${label}】开关已关闭` };
  if (desktop && desktop.taskEnabled === false) return { enabled: false, reason: `该云电脑的【🎯 任务】开关已关闭，已尊重用户意图跳过${label}` };
  return { enabled: true, reason: '' };
}

// ==========================================================
// 生产级天翼云原生客户端（纯协议实现保活心跳与会话链路）
// ==========================================================
class CtYunClient {
  constructor(account) {
    this.account = account;
    this.version = '103020001';
    this.deviceType = '60';
    this.loginInfo = account.savedLoginInfo || null;
    this.ws = null;
    this.wsAlive = false;
    this.encryptor = new CtYunEncryption();
    
    const todayStr = getBeijingDateOnly();
    const stats = account.stats || {};
    this.lastSuccessDate = stats.lastSuccessDate || todayStr;
    const initialTodayCount = (stats.lastSuccessDate === todayStr) ? (stats.todaySuccessCount || 0) : 0;

    this.metrics = {
      status: 'offline',
      currentHost: '',
      desktopName: '',
      keepAliveSeconds: appConfig.settings?.keepAliveSeconds || 60,
      cycleCountdown: 60,
      lastHeartbeatTime: '',
      lastHeartbeatResult: '未建立连接',
      successCount: initialTodayCount,
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
    this.externalYieldUntil = 0; // 官方客户端抢占避让截止时间戳
    this.lastTokenRenewAt = Date.now();
    this.isTaskHanging = false; // 是否正在执行 Scheduler 精准调度的 1 小时挂机任务
    this.hangRetryTimer = null; // 挂机任务自动重试定时器 (未达标自愈续跑)
    this.hangRetryCount = 0;    // 当日挂机重试次数 (上限 24 次)
    this.hangReconnectCount = 0;      // 单次 runHangTask 内的"经证据鉴别后允许重连"次数 (上限 3)
    this.hangUnverifiedStreak = 0;    // 连续"取不到证据"的次数：达到阈值后退避更久，避免任何形式的顶人风暴
    this.signVerifyTimer = null;      // 打卡"待官方确认"复检定时器
    this.signVerifyPendingSince = null;
    this.signVerifyRound = 0;
  }

  // 检测今日挂机 1 小时任务是否已达成 (严格依据今日真实达成状态)
  // 开关语义统一入口：供本文件与 app/tasks/* 共用，杜绝各处就地读取原始字段
  resolveTask(taskType, desktop = null) {
    return resolveTaskEnabled(this.account, desktop, taskType);
  }

  isTodayHangTaskCompleted() {
    const todayStr = getBeijingDateOnly();
    // 1. 优先依据官方任务中心最新进度
    if (this.metrics.officialTasks && this.metrics.officialTasks.length > 0) {
      const hangTask = this.metrics.officialTasks.find(t => t.name.includes('使用1小时'));
      if (hangTask) {
        return hangTask.status === 2 || (hangTask.total > 0 && hangTask.current >= hangTask.total);
      }
    }
    // 2. 本地记录判定：必须是今日时间戳且达到 60 分钟
    if (this.account.stats?.lastHangTime && this.account.stats.lastHangTime.startsWith(todayStr)) {
      if ((this.account.stats.hangMinutesToday || 0) >= 60) {
        return true;
      }
    }
    return false;
  }

  // 官方 App / PC 客户端抢占自愈：后台主动让位后探测式恢复 (释放后脉冲从零重新计时)
  yieldToExternalClient(durationMinutes = 5) {
    const accName = this.account.name || this.account.user;
    this.externalYieldUntil = Date.now() + durationMinutes * 60 * 1000;
    this.metrics.status = 'online';
    this.metrics.lastHeartbeatResult = `官方客户端 (App/PC) 使用中，后台已主动让位避让 (剩余 ${durationMinutes} 分钟)`;
    appendLog('KeepAlive', `[${accName}] ⚡ 检测到官方客户端 (App/PC/网页) 正在连接使用，后台长连接立即主动让位避让 ${durationMinutes} 分钟，杜绝争抢通道！`, 'info');
    if (this.endCurrentSession) {
      this.endCurrentSession('Yield to External Client');
    }
  }

  // 挂机任务自愈重试调度：今日任务未达成时自动续跑 (尊重避让冷却与用户操作，绝不反抢)
  scheduleHangRetry(onLog = console.log) {
    const accName = this.account.name || this.account.user;
    if (this.hangRetryTimer) clearTimeout(this.hangRetryTimer);
    if (this.account.features?.cloudHang === false) return;
    if (this.account.enabled === false) return;
    if (this.hangRetryCount >= 24) {
      onLog('Hang', `[${accName}] 今日挂机自动重试已达上限 (24 次)，为避免夜间无谓重试已停止续跑，明日调度将自动执行。`, 'info');
      return;
    }

    const nowTs = Date.now();
    const yieldRemain = Math.max(this.externalYieldUntil - nowTs, 0);
    const webRemain = (this.isWebUserActive && this.webUserActiveUntil > nowTs) ? (this.webUserActiveUntil - nowTs) : 0;
    const maxRemain = Math.max(yieldRemain, webRemain);
    // 有避让冷却时按冷却结束 + 30 秒精准续跑；无冷却时默认 5 分钟后重试
    const delayMs = maxRemain > 0 ? (maxRemain + 30000) : (5 * 60 * 1000);
    this.hangRetryCount++;
    const waitMin = Math.max(1, Math.round(delayMs / 60000));
    onLog('Hang', `[${accName}] 🕓 今日挂机任务尚未达成，已安排自动重试 (第 ${this.hangRetryCount}/24 次，约 ${waitMin} 分钟后自动续跑)...`, 'info');

    this.hangRetryTimer = setTimeout(async () => {
      this.hangRetryTimer = null;
      try {
        await this.runHangTask(onLog);
      } catch (e) {
        onLog('Hang', `[${accName}] 挂机自动重试异常: ${e.message}`, 'error');
        this.scheduleHangRetry(onLog);
      }
    }, delayMs);
  }

  // 清除挂机重试定时器 (任务达成 / 用户关闭挂机开关时调用)
  clearHangRetry() {
    if (this.hangRetryTimer) {
      clearTimeout(this.hangRetryTimer);
      this.hangRetryTimer = null;
    }
    this.hangRetryCount = 0;
  }

  // ==========================================================
  // 登录打卡的"待官方确认"复检机制 (暗线 C 的结构性修复)
  // ----------------------------------------------------------
  // 历史缺陷：打卡在固定 300 秒观察窗内未获官方确认即结束，且返回 success:true，
  // 造成"日志说成功、积分实际未到"。用户实测官方落账延迟约 14 分钟，远大于 5 分钟窗口。
  // 修复原则：窗口只用于【何时释放通道】，绝不作为【成败的判定依据】。
  // 判定一律以官方任务中心为准，通过跨分钟多次复检收敛 —— 复检期间绝不重新认领，因此不会顶人。
  // ==========================================================
  isSignTaskDone() {
    const t = this.metrics.officialTasks?.find(x => x.name.includes('登录AI云电脑') || x.name.includes('登录'));
    return !!(t && (t.status === 2 || (t.total > 0 && t.current >= t.total)));
  }

  clearSignVerify() {
    if (this.signVerifyTimer) {
      clearTimeout(this.signVerifyTimer);
      this.signVerifyTimer = null;
    }
    this.signVerifyPendingSince = null;
    this.signVerifyRound = 0;
  }

  /**
   * 认领已下发、官方尚未确认时调用：安排跨分钟复检，只读官方状态，绝不再次认领。
   * @param {(src:string,msg:string,lvl:string)=>void} onLog 日志回调
   * @param {number} totalWaitMinutes 观察总时长（默认 45 分钟，覆盖实测约 14 分钟的落账延迟）
   */
  scheduleSignVerify(onLog = console.log, totalWaitMinutes = 45) {
    const accName = this.account.name || this.account.user;
    if (!this.signVerifyPendingSince) this.signVerifyPendingSince = Date.now();
    if (this.signVerifyTimer) return;

    const stepMin = 5;
    this.signVerifyRound = this.signVerifyRound || 0;
    const elapsedMin = Math.floor((Date.now() - this.signVerifyPendingSince) / 60000);

    if (elapsedMin >= totalWaitMinutes) {
      onLog('Sign', `[${accName}] ⏳ 打卡复检已满 ${totalWaitMinutes} 分钟，官方任务中心仍未确认【登录AI云电脑】达成。本次打卡判定为【未达成】——不再重试认领，等待用户客户端登录或下一次调度。`, 'warning');
      this.clearSignVerify();
      return;
    }

    this.signVerifyRound++;
    onLog('Sign', `[${accName}] 🕓 打卡认领已下发，官方尚未确认 (已等待约 ${elapsedMin} 分钟)。安排 ${stepMin} 分钟后复检官方任务中心 (第 ${this.signVerifyRound} 次，最长观察 ${totalWaitMinutes} 分钟；复检期间不重新认领，不会打扰客户端)。`, 'info');

    this.signVerifyTimer = setTimeout(async () => {
      this.signVerifyTimer = null;
      try {
        const r = await this.refreshOfficialTasks();
        if (!r || r.ok === false) {
          onLog('Sign', `[${accName}] 打卡复检未能读到官方任务中心 (${(r && r.reason) || '原因未知'})，本次不判定，稍后继续复检。`, 'warning');
          this.scheduleSignVerify(onLog, totalWaitMinutes);
          return;
        }
        if (this.isSignTaskDone()) {
          const nowStr = getBeijingTimeString();
          this.account.stats.lastSignTime = nowStr;
          saveConfig(appConfig);
          onLog('Sign', `🎉 官方任务中心已确认【登录AI云电脑】达成 (+100积分)！打卡完成时间 ${nowStr}。`, 'success');
          sendAccountNotification(this.account, `✅ 登录打卡达成 - ${accName}`, `账号【${accName}】今日登录AI云电脑任务已完成，100 积分已到账！`);
          this.clearSignVerify();
          return;
        }
        this.scheduleSignVerify(onLog, totalWaitMinutes);
      } catch (e) {
        onLog('Sign', `[${accName}] 打卡复检异常: ${e.message}，稍后继续。`, 'warning');
        this.scheduleSignVerify(onLog, totalWaitMinutes);
      }
    }, stepMin * 60 * 1000);
  }

  /**
   * 挂机中断来源证据化鉴别。
   *
   * 判定方向的不对称性是本函数的全部意义所在：
   *   - 误判为 real_client  → 代价只是我们自己多等 10 分钟 (不打扰任何人)
   *   - 误判为 false_alarm  → 代价是把正在使用云电脑的真实用户顶下线 (不可接受)
   * 因此凡"取不到可信证据"一律返回 'unverified'，并由调用方按 real_client 处理。
   * 这正是历史上"没有证据被当成没有用户"的反面。
   *
   * 【2026-09-23 用户实测调整】观察总时长 90 秒 → 5 分钟。
   * 背景：用户实测「90 秒内官方挂机计时并未增长，但人确实在用」，导致误判为无人在用而被反复顶下线。
   * 用户要求先验证"是不是 90 秒太短、不足以等到官方落账变化"，故把采样跨度拉到 5 分钟。
   * 注意：本调整**只在"官方计时为延迟落账"时有效**。若 5 分钟内仍恒定不变，
   * 则说明计时根本不随我们的协议会话推进（按官方客户端会话结算），
   * 此时延长窗口无效，须改为"取不到增长证据一律按可能有真人处理"（翻转判定方向）。
   */
  async diagnoseHangInterruption(onLog = console.log, targetName = '云电脑', preRefresh = null) {
    const accName = this.account.name || this.account.user;
    const getUsage = () => {
      const t = this.metrics.officialTasks?.find(x => x.name.includes('使用1小时'));
      return t ? (t.current || 0) : 0;
    };

    const r1 = preRefresh || await this.refreshOfficialTasks();
    if (!r1 || r1.ok === false) {
      appendLog('Hang', `[${accName}][${targetName}] 🔎 无法鉴别中断来源：官方任务中心不可读 (${(r1 && r1.reason) || '原因未知'})。取不到证据即不得重新认领，按"可能有真机用户"处理。`, 'warning');
      return 'unverified';
    }
    if (this.isTodayHangTaskCompleted()) return 'completed';

    const before = getUsage();

    // 观察参数：5 次采样 × 60 秒 = 总跨度 5 分钟（用户指定）。
    // 采样间隔仍取 60 秒，是为了覆盖官方"按分钟粒度落账"的跳变边界 ——
    // 一次性只睡 5 分钟再取值，可能恰好落在两次跳变之间而看不到增量。
    const DIAG_SAMPLES = 5;
    const DIAG_GAP_MS = 60000;
    const totalMin = Math.round((DIAG_SAMPLES * DIAG_GAP_MS) / 60000);
    onLog('Hang', `[${targetName}] 🔎 正在鉴别中断来源 (观察约 ${totalMin} 分钟，检查官方计时是否继续增长；当前 ${before}s)...`, 'info');

    let maxSeen = before;
    for (let i = 0; i < DIAG_SAMPLES; i++) {
      await new Promise(r => setTimeout(r, DIAG_GAP_MS));
      const r = await this.refreshOfficialTasks();
      if (!r || r.ok === false) {
        appendLog('Hang', `[${accName}][${targetName}] 🔎 鉴别过程第 ${i + 1} 次取值失败 (${(r && r.reason) || '原因未知'})，无法形成结论，按"可能有真机用户"处理。`, 'warning');
        return 'unverified';
      }
      if (this.isTodayHangTaskCompleted()) return 'completed';
      const seen = getUsage();
      maxSeen = Math.max(maxSeen, seen);
      appendLog('Hang', `[${accName}][${targetName}] 🔎 鉴别采样 ${i + 1}/${DIAG_SAMPLES} (第 ${(i + 1)} 分钟)：官方计时 ${seen}s (初始 ${before}s，最大 ${maxSeen}s)。`, 'info');
    }

    const delta = maxSeen - before;
    // 阈值取 30 秒：本会话此时已断开，官方计时若仍在增长即说明另有他人在使用。
    // 【已知局限】"计时未增长"是否等价于"无人在用"，尚待本次 5 分钟实测验证 ——
    // 用户曾实测 90 秒内计时不涨却确实在用，若 5 分钟仍不涨，则本条注释的前提不成立，
    // 需按上方函数注释所述翻转判定方向。

    const verdict = delta >= 30 ? 'real_client' : 'false_alarm';
    appendLog('Hang', `[${accName}][${targetName}] 中断鉴别结果: ${totalMin} 分钟内官方计时 ${before}s → ${maxSeen}s (增量 ${delta}s)，判定 = ${verdict === 'real_client' ? '真实客户端正在使用 (计时持续增长)，必须让位' : '无人在用 (计时冻结)，可安全续连'}`, 'info');
    return verdict;
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

  // 手动/交互模式登录验证（提供验证码和 challengeId）
  async loginWithCaptcha(captchaCode, challengeId, challengeCode) {
    const user = this.account.user;
    const password = this.account.password;
    const deviceCode = this.account.deviceCode;

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
      this.account.savedLoginInfo = result.data;
      this.account.bound = !!result.data.bondedDevice;
      this.account.sessionExpired = false;
      saveConfig(appConfig);
      return { success: true, data: result.data };
    }

    return { 
      success: false, 
      error: result.msg || '登录失败，请检查验证码或密码！',
      code: result.code 
    };
  }

  // 生成单点登录/免密直通 Token (用于无感静默续期与直达操作)
  async genLoginToken(effectiveSeconds = 300) {
    if (!this.loginInfo) {
      throw new Error('账号尚未登录，无法生成登录 Token');
    }
    // 瞬态防护：单次重试 (5 秒间隔)，规避偶发的服务端并发刷新冲突
    let lastErr = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await fetchWithTimeout('https://desk.ctyun.cn:8810/api/auth/client/genLoginToken', {
        method: 'POST',
        headers: this.getSignedHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ authAppModel: 34, effectiveSeconds })
      });
      const json = await res.json();
      if (json.code === 0 && json.data?.token) {
        return json.data.token;
      }
      lastErr = `${json.msg || '获取免密 Token 失败'} (Code: ${json.code})`;
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    throw new Error(lastErr);
  }

  // 无感静默轮转刷新 Token (通过现有会话生成免密票据并重新登录换取全新凭据，彻底杜绝会话失效)
  async renewToken() {
    if (!this.loginInfo) {
      throw new Error('账号尚未登录，无法续期');
    }
    const dcMasked = String(this.account.deviceCode || '无').replace(/^(.{10}).*(.{4})$/, '$1****$2');
    let loginToken;
    try {
      loginToken = await this.genLoginToken(300);
    } catch (e) {
      // 环节定位①：签发 (genLoginToken) 被拒 = 官方拒绝本会话签发新免密凭据
      throw new Error(`签发免密凭据被拒: ${e.message} [设备码: ${dcMasked}, UserId: ${this.loginInfo.userId}]`);
    }
    let newInfo;
    try {
      newInfo = await this.loginByToken(loginToken);
    } catch (e) {
      // 环节定位②：消费 (tokenLogin) 被拒 = 官方拒绝用该凭据建立新会话
      throw new Error(`消费免密凭据被拒: ${e.message} [设备码: ${dcMasked}, UserId: ${this.loginInfo.userId}]`);
    }
    this.loginInfo = newInfo;
    this.account.savedLoginInfo = newInfo;
    this.account.sessionExpired = false;
    saveConfig(appConfig);
    appendLog('Auth', `[${this.account.name || this.account.user}] 🔄 天翼云会话已自动无感续期刷新！`, 'info', this.account.name, 'ctyun');
    return newInfo;
  }

  // 会话失效检测与 Webhook 告警机制
  handleSessionExpired(reason = '登录凭据失效') {
    const accName = this.account.name || this.account.user;
    if (this.account.sessionExpired) return; // 避免重复触发风暴告警
    this.account.sessionExpired = true;
    this.account.stats = this.account.stats || {};
    this.account.stats.keepAliveStatus = 'offline';
    saveConfig(appConfig);

    appendLog('Auth', `[${accName}] ⚠️ 登录会话完全失效 (${reason})，已停用自动重试并发出告警通知！`, 'error');
    sendAccountNotification(
      this.account,
      `⚠️ 天翼云账号凭据失效 - ${accName}`,
      `账号【${accName}】的登录凭据已完全过期或失效 (${reason})。系统已自动停止无效重试，请前往 Web 控制台重新验证登录。`,
      { account: accName, task: '凭据维护', status: '会话失效' }
    );
  }

  async login(maxRetries = 1) {
    if (this.loginInfo && !this.account.sessionExpired) {
      // 命中内存缓存：未产生任何真实网络登录事件 (fromCache 标记供签到等需要真实登录事件的调用方区分)
      return { success: true, data: this.loginInfo, fromCache: true };
    }
    // 优先尝试无感静默续期刷新
    if (this.loginInfo) {
      try {
        const newInfo = await this.renewToken();
        if (newInfo) {
          return { success: true, data: newInfo };
        }
      } catch (e) {}
    }
    this.handleSessionExpired('会话已过期，需要人工验证登录');
    return { success: false, error: '会话已过期，请在控制台输入验证码重新登录！' };
  }

  getSignedHeaders(customHeaders = {}) {
    if (!this.loginInfo) return {};
    const timestamp = Date.now().toString();
    const str = `${this.deviceType}${timestamp}${this.loginInfo.tenantId}${timestamp}${this.loginInfo.userId}${this.version}${this.loginInfo.secretKey}`;
    const sig = md5(str);
    const headers = {
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
    // 协议对齐 ctyun-pro：官方会话令牌 Cookie (genLoginToken/tokenLogin 等鉴权签发类接口
    // 依赖此 Cookie 关联"当前设备会话"；缺失时官方按未知设备处理，导致免密凭据被拒)
    if (this.loginInfo.token) {
      headers['Cookie'] = `token=${this.loginInfo.token}`;
    }
    return headers;
  }

  // 智能解析云电脑硬件规格 (完全对齐 ctyun-pro parseDesktopSpec 策略)
  // 天翼云官方列表接口不直接下发 cpuCore/memoryGB 数值字段，规格一律从 flavorName / desktopName 文本中提取，
  // 提取不到时按官方套餐版本名智能映射 (旗舰版 16C32G / 尊享·精英 8C16G / 标准 4C8G / 政企 8C16G)
  static extractDesktopSpecs(item = {}, defaultFlavor = '') {
    const flavor = String(item.flavorName || item.prodGroupName || '');
    const name = String(item.desktopName || item.objName || item.poolName || '');

    // 1. 优先从 flavorName 与 desktopName 中提取显式 "4C8G / 8C16G / 4核8G" 规格
    const specMatch = flavor.match(/(\d+C\d+G)/i) || name.match(/(\d+C\d+G)/i);
    if (specMatch) {
      const spec = specMatch[1].toUpperCase(); // e.g. "8C16G"
      const cpuNum = spec.match(/^(\d+)C/)[1];
      const memNum = spec.match(/C(\d+)G/)[1];
      return {
        cpu: `${cpuNum}核`,
        memory: `${memNum}G`,
        os: 'Windows',
        flavorName: flavor || defaultFlavor,
        specStr: `${cpuNum}核/${memNum}G`
      };
    }

    // 2. 兼容 "4核8G / 4核/8G / 4vCPU 8GB" 等中文变体写法
    const cnMatch = (flavor + ' ' + name).match(/(\d+)\s*(?:核|vCPU)\s*[/]?\s*(\d+)\s*(?:G|GB|GiB)/i);
    if (cnMatch) {
      return {
        cpu: `${cnMatch[1]}核`,
        memory: `${cnMatch[2]}G`,
        os: 'Windows',
        flavorName: flavor || defaultFlavor,
        specStr: `${cnMatch[1]}核/${cnMatch[2]}G`
      };
    }

    // 3. 按官方套餐版本名智能映射 (ctyun-pro 同款策略)
    let spec = '8C16G'; // 默认为 8C16G (ctyun-pro 同款兜底)
    if (name.includes('旗舰版') || flavor.includes('旗舰版')) spec = '16C32G';
    else if (name.includes('尊享版') || flavor.includes('尊享版') || name.includes('精英版') || flavor.includes('精英版')) spec = '8C16G';
    else if (name.includes('标准版') || flavor.includes('标准版')) spec = '4C8G';
    else if (name.includes('政企') || flavor.includes('政企') || item.isPool || item.objType === 1) spec = '8C16G';

    const cpuNum = spec.match(/^(\d+)C/)[1];
    const memNum = spec.match(/C(\d+)G/)[1];

    return {
      cpu: `${cpuNum}核`,
      memory: `${memNum}G`,
      os: 'Windows',
      flavorName: flavor || defaultFlavor,
      specStr: `${cpuNum}核/${memNum}G`
    };
  }

  // 解析天翼云全形态云电脑列表 (普通独立单机、政企桌面池 POOL、抢占式桌面)
  static parseAllDesktops(data = {}) {
    const list = [];
    const seen = new Set();

    // 1. 普通单机 (公众版 / 个人独立机 / 尊享版等)
    if (Array.isArray(data.desktopList)) {
      for (const item of data.desktopList) {
        const id = String(item.desktopId || item.objId || '');
        if (id && !seen.has(id)) {
          seen.add(id);
          const spec = CtYunClient.extractDesktopSpecs(item, '公众版');
          list.push({
            desktopId: id,
            objId: String(item.objId || id),
            desktopName: item.desktopName || item.objName || '天翼云电脑',
            desktopCode: item.desktopCode || '',
            useStatusText: item.useStatusText || item.useStatus || '运行中',
            useStatus: item.useStatus,
            imageName: item.imageName || '',
            flavorName: spec.flavorName,
            cpu: spec.cpu,
            memory: spec.memory,
            os: spec.os,
            specStr: spec.specStr,
            objType: item.objType ?? 0,
            isPool: false
          });
        }
      }
    }

    // 2. 政企桌面池 (POOL)
    if (Array.isArray(data.desktopPoolList)) {
      for (const item of data.desktopPoolList) {
        const poolId = String(item.poolId || item.objId || item.desktopId || '');
        const id = String(item.desktopId || poolId);
        if (id && !seen.has(id)) {
          seen.add(id);
          const spec = CtYunClient.extractDesktopSpecs(item, '政企版');
          list.push({
            desktopId: id,
            objId: poolId,
            desktopName: item.poolName || item.desktopName || '天翼云电脑(政企桌面池)',
            desktopCode: item.desktopCode || poolId,
            useStatusText: item.useStatusText || item.useStatus || '运行中',
            useStatus: item.useStatus,
            imageName: item.imageName || '',
            flavorName: spec.flavorName,
            cpu: spec.cpu,
            memory: spec.memory,
            os: spec.os,
            specStr: spec.specStr,
            objType: item.objType ?? 1,
            isPool: true
          });
        }
      }
    }

    // 3. 抢占式云电脑 (Preemption)
    if (Array.isArray(data.preemptionDesktopList)) {
      for (const item of data.preemptionDesktopList) {
        const id = String(item.desktopId || item.objId || '');
        if (id && !seen.has(id)) {
          seen.add(id);
          const spec = CtYunClient.extractDesktopSpecs(item, '抢占式');
          list.push({
            desktopId: id,
            objId: id,
            desktopName: item.desktopName || '天翼云电脑(抢占式)',
            desktopCode: item.desktopCode || id,
            useStatusText: item.useStatusText || item.useStatus || '运行中',
            useStatus: item.useStatus,
            imageName: item.imageName || '',
            flavorName: spec.flavorName,
            cpu: spec.cpu,
            memory: spec.memory,
            os: spec.os,
            specStr: spec.specStr,
            objType: item.objType ?? 2,
            isPool: false
          });
        }
      }
    }

    return list;
  }

  // 官方扫码登录 1: 生成二维码数据
  async genQrCode() {
    const res = await fetchWithTimeout('https://desk.ctyun.cn:8810/api/auth/client/qrCode/genData', {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0',
        'ctg-devicetype': this.deviceType,
        'ctg-version': this.version,
        'ctg-devicecode': this.account.deviceCode,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    const json = await res.json();
    if (json.code !== 0 || !json.data?.qrCodeId) {
      throw new Error(json.msg || '获取二维码失败');
    }
    const qrCodeId = json.data.qrCodeId;
    let qrUrl = '';
    if (json.data.qrCodeEndpoint) {
      const endpoint = json.data.qrCodeEndpoint;
      const sep = endpoint.includes('?') ? '&' : '?';
      qrUrl = `${endpoint}${sep}qrCodeId=${encodeURIComponent(qrCodeId)}&loginMode=1`;
    } else {
      qrUrl = `https://desk.ctyun.cn/selforder/#/login-confirm?qrCodeId=${encodeURIComponent(qrCodeId)}&loginMode=1`;
    }
    return { qrCodeId, qrUrl };
  }

  // 官方扫码登录 2: 轮询二维码授权状态
  async getQrCodeStatus(qrCodeId) {
    const res = await fetchWithTimeout(`https://desk.ctyun.cn:8810/api/auth/client/qrCode/getStatus?qrCodeId=${encodeURIComponent(qrCodeId)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0',
        'ctg-devicetype': this.deviceType,
        'ctg-version': this.version,
        'ctg-devicecode': this.account.deviceCode,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    const json = await res.json();
    if (json.code !== 0 || !json.data) {
      throw new Error(json.msg || '查询扫码状态失败');
    }
    return {
      codeStatus: json.data.codeStatus,
      loginToken: json.data.loginToken || undefined
    };
  }

  // 官方扫码登录 3: 通过 Token 换取正式登录态
  async loginByToken(accessToken) {
    // 关键自愈：免密凭据与"签发会话的设备"绑定。若账号当前 deviceCode 与会话签发设备不一致
    // (常见于长期未重新验证 / 迁移部署 / 重新生成过设备码)，官方将拒绝: "不允许在当前设备使用此凭据"。
    // 因此优先提交会话自身携带的 deviceCode，保证凭据签发设备与消费设备严格一致。
    const sessionDeviceCode = this.loginInfo?.deviceCode || this.account.deviceCode;
    const baseHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0',
      'ctg-devicetype': this.deviceType,
      'ctg-version': this.version,
      'ctg-devicecode': sessionDeviceCode,
      'Content-Type': 'application/json'
    };
    // 核心对齐：若已有会话进行 renewToken 续期，必须使用带会话 Cookie 与签名的 headers，
    // 否则官方鉴权中心将此请求视为无上下文的裸请求，拒绝消费该免密凭据
    const reqHeaders = this.loginInfo ? this.getSignedHeaders(baseHeaders) : baseHeaders;

    const res = await fetchWithTimeout('https://desk.ctyun.cn:8810/api/auth/client/tokenLogin', {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify({
        accessToken,
        osType: 'Windows',
        deviceModel: 'Windows NT 10.0; Win64; x64',
        appVersion: '3.2.0',
        deviceCode: sessionDeviceCode,
        deviceName: 'Chrome浏览器',
        deviceType: this.deviceType,
        sysVersion: 'Windows NT 10.0; Win64; x64',
        clientVersion: this.version
      })
    });
    const json = await res.json();
    if (json.code !== 0 && json.code !== 200) {
      throw new Error(`${json.msg || '登录验证失败'} (Code: ${json.code})`);
    }
    this.loginInfo = json.data;
    this.account.savedLoginInfo = json.data;
    this.account.bound = true;
    this.account.sessionExpired = false;
    // 会话设备码回写对齐：续期成功后账号设备码与会话完全一致，后续轮转永不再错配
    if (json.data.deviceCode) {
      this.account.deviceCode = json.data.deviceCode;
    } else if (this.loginInfo?.deviceCode) {
      this.account.deviceCode = this.loginInfo.deviceCode;
    }
    if (json.data.mobilephone) {
      this.account.user = json.data.mobilephone;
    }
    saveConfig(appConfig);
    return json.data;
  }

  // 获取绑定设备短信图形验证码
  async getSmsCodeCaptcha() {
    const timestamp = Date.now();
    const url = `https://desk.ctyun.cn:8810/api/auth/client/validateCode/captcha?width=120&height=40&_t=${timestamp}`;
    const res = await fetchWithTimeout(url, { headers: this.getSignedHeaders() });
    if (!res.ok) {
      throw new Error(`获取短信验证码图验失败: HTTP ${res.status}`);
    }
    const captchaKey = res.headers.get('ctg-captcha-key') || res.headers.get('CTG-CAPTCHA-KEY') || '';
    const arrayBuffer = await res.arrayBuffer();
    const base64Img = `data:image/jpeg;base64,${Buffer.from(arrayBuffer).toString('base64')}`;
    return { captchaImage: base64Img, captchaKey };
  }

  // 发送短信验证码 (官方风控要求携带 captchaCode 与 captchaCodeKey)
  async sendSmsCode(userPhone, captchaCode, captchaCodeKey = '') {
    let url = `https://desk.ctyun.cn:8810/api/cdserv/client/device/getSmsCode?mobilePhone=${encodeURIComponent(userPhone)}&captchaCode=${encodeURIComponent(captchaCode)}`;
    if (captchaCodeKey) {
      url += `&captchaCodeKey=${encodeURIComponent(captchaCodeKey)}`;
    }
    const res = await fetchWithTimeout(url, { headers: this.getSignedHeaders() });
    const smsKey = res.headers.get('ctg-sms-key') || res.headers.get('CTG-SMS-KEY') || '';
    const json = await res.json();
    if (json.code !== 0 && json.code !== 200) {
      throw new Error(json.msg || '发送短信验证码失败');
    }
    return { success: true, smsKey };
  }

  // 绑定设备 (官方要求携带 verificationCode 与 smsCodeKey)
  async bindDevice(verificationCode, smsCodeKey = '') {
    const formData = new URLSearchParams();
    formData.append('verificationCode', verificationCode.trim());
    if (smsCodeKey) {
      formData.append('smsCodeKey', smsCodeKey.trim());
    }
    formData.append('deviceName', 'Chrome浏览器');
    formData.append('deviceCode', this.account.deviceCode);
    formData.append('deviceModel', 'Windows NT 10.0; Win64; x64');
    formData.append('sysVersion', 'Windows NT 10.0; Win64; x64');
    formData.append('appVersion', '3.2.0');
    formData.append('hostName', 'pc.ctyun.cn');
    formData.append('deviceInfo', 'Win32');

    const url = 'https://desk.ctyun.cn:8810/api/cdserv/client/device/binding';
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: this.getSignedHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: formData.toString()
    });

    const json = await res.json();
    if (json.code !== 0 && json.code !== 200) {
      throw new Error(json.msg || '绑定设备失败');
    }
    if (this.loginInfo) {
      this.loginInfo.bondedDevice = true;
    }
    return { success: true };
  }

  async getDesktops() {
    if (!this.loginInfo) {
      return this.desktopsCache || [];
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      const mergedList = [];
      const seenIds = new Set();
      let isAuthExpired = false;

      // 1. 全规格 pageDesktop 查询云电脑 (支持独立机、池化及抢占式)
      try {
        const res = await fetchWithTimeout('https://desk.ctyun.cn:8810/api/desktop/client/pageDesktop', {
          method: 'POST',
          headers: this.getSignedHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            getCnt: 50,
            desktopTypes: ['1', '2001', '2002', '2003'],
            sortType: 'createTimeV1'
          })
        });
        const json = await res.json();
        if (json.code === 0 && json.data) {
          const list1 = CtYunClient.parseAllDesktops(json.data);
          for (const d of list1) {
            const id = String(d.desktopId || d.objId || '');
            if (id && !seenIds.has(id)) {
              seenIds.add(id);
              mergedList.push(d);
            }
          }
        } else if (json.code === 40010 || String(json.msg || '').includes('登录信息已过期') || String(json.msg || '').includes('会话已过期')) {
          isAuthExpired = true;
        }
      } catch (e) {}

      // 2. 官方备用接口合并：api/desktop/client/list (覆盖所有自建、公有池与专属云电脑类型)
      try {
        const resList = await fetchWithTimeout('https://desk.ctyun.cn:8810/api/desktop/client/list', {
          method: 'GET',
          headers: this.getSignedHeaders()
        });
        const jsonList = await resList.json();
        if (jsonList.code === 0 && jsonList.data) {
          const list2 = CtYunClient.parseAllDesktops(jsonList.data);
          for (const d of list2) {
            const id = String(d.desktopId || d.objId || '');
            if (id && !seenIds.has(id)) {
              seenIds.add(id);
              mergedList.push(d);
            }
          }
        } else if (jsonList.code === 40010 || String(jsonList.msg || '').includes('登录信息已过期') || String(jsonList.msg || '').includes('会话已过期')) {
          isAuthExpired = true;
        }
      } catch (e) {}

      if (mergedList.length > 0) {
        // 差量合并引擎 (Diff-Merge)：保留用户本地已设置的单机保活与任务偏好
        const oldMap = new Map((this.account.desktops || this.desktopsCache || []).map(d => [String(d.desktopId || d.objId), d]));
        for (const d of mergedList) {
          const dKey = String(d.desktopId || d.objId);
          const old = oldMap.get(dKey);
          if (old) {
            if (old.keepaliveEnabled !== undefined) d.keepaliveEnabled = old.keepaliveEnabled;
            if (old.taskEnabled !== undefined) d.taskEnabled = old.taskEnabled;
            if (old.autoBootEnabled !== undefined) d.autoBootEnabled = old.autoBootEnabled;
            if (old.keepaliveInterval !== undefined) d.keepaliveInterval = old.keepaliveInterval;
            if (old.lastPulseAt !== undefined) d.lastPulseAt = old.lastPulseAt;
          } else {
            if (d.keepaliveEnabled === undefined) d.keepaliveEnabled = true;
            if (d.taskEnabled === undefined) d.taskEnabled = true;
            if (d.autoBootEnabled === undefined) d.autoBootEnabled = true;
          }
        }
        this.desktopsCache = mergedList;
        this.account.desktops = mergedList;
        for (const d of mergedList) this.checkExternalPowerOn(d);
        return mergedList;
      }

      // 如果明确是会话过期错误且是第 1 次尝试，执行无感自动续期重试
      if (isAuthExpired && attempt === 1) {
        try {
          await this.renewToken();
          continue; // 用新凭据重试
        } catch (e) {
          this.handleSessionExpired('登录凭据已过期，自动续期失败');
          break;
        }
      }

      break;
    }
    return this.desktopsCache || [];
  }

  async connect(desktopId, vdCommand = '') {
    if (!this.loginInfo) {
      throw new Error('未登录');
    }

    const dIdStr = String(desktopId);

    // 1. 优先通过官方首选 status 接口获取桌面连接与证书信息 (普通单机优先)
    try {
      const statusUrl = `https://desk.ctyun.cn:8810/api/desktop/client/status?desktopId=${encodeURIComponent(dIdStr)}&specifiedCertCategory=1`;
      const sRes = await fetchWithTimeout(statusUrl, { headers: this.getSignedHeaders() });
      const sJson = await sRes.json();
      if (sJson.code === 0 && sJson.data?.desktopInfo?.clinkLvsOutHost) {
        return sJson.data.desktopInfo;
      }
      if (sJson.code === 40010 || String(sJson.msg || '').includes('登录信息已过期') || String(sJson.msg || '').includes('会话已过期')) {
        await this.renewToken().catch(() => {});
      }
    } catch (e) {}

    // 2. 备用通过 connect 接口获取 (政企桌面池 / 启动中虚拟机等)
    const connBody = new URLSearchParams({
      objId: dIdStr,
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
      desktopId: dIdStr,
      appVersion: '3.2.0',
      sysVersion: 'Windows NT 10.0; Win64; x64',
      clientVersion: this.version,
      specifiedCertCategory: '1'
    });

    const res = await fetchWithTimeout('https://desk.ctyun.cn:8810/api/desktop/client/connect', {
      method: 'POST',
      headers: this.getSignedHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: connBody.toString()
    });
    const json = await res.json();
    if (json.code === 0) {
      // 若云电脑已关机，服务端返回 desktopInfo 为 null 且带有 goingRetry: true
      return json.data?.desktopInfo || null;
    }
    if (json.code === 40010 || String(json.msg || '').includes('登录信息已过期') || String(json.msg || '').includes('会话已过期')) {
      await this.renewToken().catch(() => {});
    }
    throw new Error(json.msg || '获取云电脑连接配置失败');
  }

  // 云电脑电源管理操作 (开机: operationType 1 / 唤醒: operationType 18 / 关机: operationType 2 / 重启: operationType 3)
  async controlPower(desktopId, action) {
    const accName = this.account.name || this.account.user;
    const actionLower = (action || '').toLowerCase();

    // 天翼云底层官方电源管控协议 operationType: 1=开机(ON), 18=唤醒(AWAKE), 2=关机(SHUTDOWN), 3=重启(RESET)
    let opType = 3;
    let actionCn = '重启';
    if (actionLower === 'poweron' || actionLower === 'start') {
      opType = 1;
      actionCn = '开机';
    } else if (actionLower === 'awake' || actionLower === 'wakeup' || actionLower === 'resume') {
      opType = 18;
      actionCn = '唤醒';
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

    // 执行电源指令
    const sendOperate = async (targetOpType) => {
      const form = new URLSearchParams({
        desktopId: String(desktopId),
        operationType: String(targetOpType)
      });
      const res = await fetchWithTimeout('https://desk.ctyun.cn:8810/api/desktop/client/operate', {
        method: 'POST',
        headers: this.getSignedHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
        body: form.toString()
      });
      return await res.json();
    };

    // 开机/唤醒双重信令链路 (Triple Link)
    if (opType === 1 || opType === 18) {
      let lastErrMsg = '';
      
      // 1. 尝试主信令 (1 或 18)
      try {
        const data1 = await sendOperate(opType);
        if (data1.code === 0) {
          appendLog('System', `[${accName}] ✅ 云电脑【${actionCn}】指令已成功生效！`, 'success');
          return { success: true, message: `云电脑【${actionCn}】指令已成功下发！官方已确认启动。` };
        }
        lastErrMsg = data1.msg || `错误码 ${data1.code}`;
      } catch (e) {
        lastErrMsg = e.message;
      }

      // 2. 若主信令未成功，尝试互补信令 (18 ↔ 1)
      const altOpType = (opType === 1) ? 18 : 1;
      const altCn = (altOpType === 18) ? '唤醒' : '开机';
      try {
        const data2 = await sendOperate(altOpType);
        if (data2.code === 0) {
          appendLog('System', `[${accName}] ✅ 云电脑【${altCn}】互补指令已成功生效！`, 'success');
          return { success: true, message: `云电脑【${altCn}】指令已成功下发！官方已确认启动。` };
        }
        lastErrMsg = data2.msg || lastErrMsg;
      } catch (e) {
        lastErrMsg = e.message || lastErrMsg;
      }

      // 3. 通用开机信令通道：调用 connect 触发天翼云网关自动拉起虚拟机 (goingRetry: true)
      try {
        const connBody = new URLSearchParams({
          objId: String(desktopId),
          objType: '0',
          osType: '15',
          deviceId: this.deviceType,
          vdCommand: '',
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
        const connRes = await fetchWithTimeout('https://desk.ctyun.cn:8810/api/desktop/client/connect', {
          method: 'POST',
          headers: this.getSignedHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
          body: connBody.toString()
        });
        const connData = await connRes.json();
        if (connData.code === 0 && connData.data?.goingRetry) {
          appendLog('System', `[${accName}] ✅ 云电脑通用启动信令已触发 (goingRetry: true)，云端正在开机...`, 'success');
          return { success: true, message: '云电脑开机信令已同步触发，云端正在启动中！' };
        }
      } catch (e) {}

      // 机器已经在运行中的容错提示
      if (lastErrMsg && (lastErrMsg.includes('运行中') || lastErrMsg.includes('正在进行') || lastErrMsg.includes('已经开机'))) {
        appendLog('System', `[${accName}] 云电脑已处于开机/运行状态中。`, 'info');
        return { success: true, message: '云电脑已处于运行状态中！' };
      }

      appendLog('System', `[${accName}] ❌ 下发电源指令【${actionCn}】失败: ${lastErrMsg}`, 'error');
      return { success: false, error: lastErrMsg || '官方接口未确认开机' };
    }

    // 关机 / 重启
    try {
      const data = await sendOperate(opType);
      if (data.code === 0) {
        appendLog('System', `[${accName}] ✅ 云电脑【${actionCn}】指令已成功生效！官方返回: 成功`, 'success');
        sendAccountNotification(
          this.account,
          `⚡ 云电脑电源控制生效 - ${accName}`,
          `已成功向云电脑 [${accName}] 下达【${actionCn}】电源指令，天翼云已确认执行。`
        );
        return { success: true, message: `云电脑【${actionCn}】指令已成功下发并生效！` };
      } else {
        throw new Error(data.msg || `错误码 ${data.code}`);
      }
    } catch (e) {
      appendLog('System', `[${accName}] ❌ 下发电源指令【${actionCn}】失败: ${e.message}`, 'error');
      return { success: false, error: e.message };
    }
  }

  // 检测外部/官网/控制台开机：若之前处于关机/保活关闭，一旦检测到云电脑真正恢复运行中，自动恢复开启保活
  checkExternalPowerOn(desktop) {
    if (!desktop) return;
    const isRunning = desktop.useStatusText === '运行中' || desktop.useStatus == 25;
    if (isRunning && !this.resolveTask('keepAlive').enabled) {
      this.account.features.keepAlive = true;
      this.account.manualShutdown = false;
      this.account.stats = this.account.stats || {};
      this.account.stats.keepAliveStatus = 'online';
      saveConfig(appConfig);
      appendLog('KeepAlive', `[${this.account.name || this.account.user}] 🎉 检测到云电脑已成功开机启动，已自动恢复保活开关与后台长连接守护！`, 'success');
      this.startKeepAliveWorker();
    }
  }

  /**
   * 刷新官方任务中心与积分。
   *
   * 【为什么返回可信度】历史缺陷 (暗线 D)：本函数原先 catch(e){} 静默吞错，
   * 调用方拿到的是"过期的 officialTasks 快照"，却无法区分
   * "官方确认未达成" 与 "根本没取到数据"。此前多轮"假成功/假失败"都源于这一不可区分性。
   * 现在返回 { ok, reason }：ok=false 表示本次数据不可信，任何"判定"都必须放弃而不是猜。
   */
  async refreshOfficialTasks() {
    if (!this.loginInfo) return { ok: false, reason: '账号尚未登录，无法读取官方任务中心' };

    const statKeys = ['lastSignTime', 'lastAiChatTime', 'lastHangTime', 'hangMinutesToday', 'points'];
    const snapStats = () => JSON.stringify(statKeys.map(k => this.account?.stats?.[k] ?? null));
    const beforeStats = snapStats();

    let ok = false;
    let reason = '';

    try {
      const taskRes = await (await fetchWithTimeout('https://desk.ctyun.cn/selforder/api/marketing/userPoints/getTaskList', {
        headers: this.getSignedHeaders()
      })).json();

      if (taskRes.code === 40010 || String(taskRes.msg || '').includes('登录信息已过期') || String(taskRes.msg || '').includes('会话已过期')) {
        await this.renewToken().catch(() => {});
        reason = `凭据过期 (code=${taskRes.code || taskRes.msg})`;
      }

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
        ok = true;
      } else if (!reason) {
        reason = `任务中心返回异常 code=${taskRes.code} msg=${taskRes.msg || '(无)'}`;
      }

      const pointRes = await (await fetchWithTimeout('https://desk.ctyun.cn/selforder/api/marketing/userPoints/getUserPoints', {
        headers: this.getSignedHeaders()
      })).json();

      if (pointRes.code === 0 && Array.isArray(pointRes.data) && pointRes.data.length > 0) {
        // pointRes.data 数组可能包含两项，一项为 willOutDate: true 即将过期的子积分（如100分），一项为真实总积分（如900分）
        // 优先精准提取非即将过期（willOutDate != true）的主账户可用总积分项；若都无标识则取数值最大项
        const validItem = pointRes.data.find(p => !p.willOutDate && p.pointType === 1) ||
                          pointRes.data.reduce((max, cur) => ((cur.points || 0) > (max.points || 0) ? cur : max), pointRes.data[0]);
        this.metrics.userPoints = validItem ? (validItem.points || 0) : 0;
        this.account.stats.points = this.metrics.userPoints;
        ok = true;
      } else if (!reason) {
        reason = `积分接口返回异常 code=${pointRes.code}`;
      }
    } catch (e) {
      reason = `官方任务中心访问失败: ${e.message}`;
    }

    // 仅在统计字段确实发生变化时落盘 (原先每次调用都 saveConfig，在容器挂载 NAS 卷场景下为高频无效写盘)
    if (snapStats() !== beforeStats) {
      try { saveConfig(appConfig); } catch (e) { /* 落盘失败不影响本次判定 */ }
    }

    if (!ok) {
      appendLog('System', `[${this.account?.name || this.account?.user || ''}] ⚠️ 官方任务中心刷新未取得有效数据 (${reason})。本次结果不可信，系统不会据此判定任何任务成败。`, 'warning');
    }
    return { ok, reason };
  }

  async getRewards() {
    if (!this.loginInfo) await this.login();
    const res = await fetchWithTimeout('https://desk.ctyun.cn/selforder/api/selforder/prod/get?prodId=17000000&prodCode=POINTS', {
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

  // 单台云电脑视讯通道保活会话
  async runDesktopKeepAliveSession(desktop, isHangMode = false, pulseConnectSec = 20, goalTaskName = '') {
    const accName = this.account.name || this.account.user;
    const desktopId = desktop.objId || desktop.desktopId;
    const desktopName = desktop.objName || desktop.desktopName || '云电脑';

    let desktopInfo = null;
    let lastConnError = '';
    // 挂机模式加长重试窗口 (等待开机/网关就绪)：12 次 × 10 秒 ≈ 2 分钟；脉冲模式保持轻量 4 次 × 4 秒
    const maxConnAttempts = isHangMode ? 12 : 4;
    const retryGapMs = isHangMode ? 10000 : 4000;
    for (let connAttempt = 1; connAttempt <= maxConnAttempts; connAttempt++) {
      try {
        desktopInfo = await this.connect(desktopId);
      } catch (e) {
        lastConnError = e.message || '';
      }
      if (desktopInfo && desktopInfo.clinkLvsOutHost) break;

      // 先判定【开机/启动中】：此类报错 (如"正在启动中，请稍后再试") 属于等待就绪，绝非客户端占用，绝不误判让位！
      const isBootingMsg = lastConnError.includes('启动') || lastConnError.includes('开机') || lastConnError.includes('初始化') || lastConnError.includes('唤醒');
      // 再严格判定【客户端占用】：仅明确的占用信令才视为官方客户端接入
      const isOccupiedMsg = !isBootingMsg && (
        lastConnError.includes('其他设备') || lastConnError.includes('其他地方') ||
        lastConnError.includes('正在使用') || lastConnError.includes('使用中') || lastConnError.includes('占用')
      );
      if (isOccupiedMsg) {
        appendLog('KeepAlive', `[${accName}][${desktopName}] 官方客户端可能正在使用，旁观通道将在下个周期自动重试。`, 'info');
        return { success: true, reason: 'occupied' };
      }
      if (connAttempt < maxConnAttempts) {
        if (lastConnError) {
          appendLog('KeepAlive', `[${accName}][${desktopName}] 连接暂未就绪 (${lastConnError})，${Math.round(retryGapMs / 1000)} 秒后自动重试 (${connAttempt}/${maxConnAttempts})...`, 'info');
        }
        await new Promise(r => setTimeout(r, retryGapMs));
      }
    }

    if (!desktopInfo || !desktopInfo.clinkLvsOutHost) {
      appendLog('KeepAlive', `[${accName}][${desktopName}] 视讯网关暂未分配完毕 (已重试 ${maxConnAttempts} 次)，跳过本次连接`, 'warning');
      return { success: false, reason: 'no_gateway' };
    }

    this.metrics.currentHost = desktopInfo.clinkLvsOutHost;
    const wsUrl = `wss://${desktopInfo.clinkLvsOutHost}/clinkProxy/${desktopId}/MAIN`;

    return await new Promise((resolveSession) => {
      let cycleDone = false;
      let isClosingSelf = false;
      let sessionTimeout = null;
      let hangCheckInterval = null;
      let wsConnectedAt = 0;
      let goalAchieved = false; // 目标任务 (如登录AI云电脑) 是否已获得官方确认
      let clientPresenceSignal = false; // 官方客户端在席信令 (Type 119/120/137)：收到即代表真机用户接入
      // 诊断埋点 (零行为改动)：记录会话握手阶段的关键事实，供断开时判断"真机抢占"还是"网络抖动"
      let handshakeDone = false; // 是否收到过 Type 103 并完成 118 身份上报
      let claimSent = false;     // 是否已发送 Type 112/104 独占认领
      let redqCount = 0;         // REDQ 挑战应答累计次数

      const endSession = (reason) => {
        if (cycleDone) return;
        cycleDone = true;
        isClosingSelf = true;
        this.endCurrentSession = null;
        if (sessionTimeout) clearTimeout(sessionTimeout);
        if (this.countdownTimer) clearInterval(this.countdownTimer);
        if (this.clinkPingTimer) {
          clearInterval(this.clinkPingTimer);
          this.clinkPingTimer = null;
        }
        if (hangCheckInterval) {
          clearInterval(hangCheckInterval);
          hangCheckInterval = null;
        }
        if (this.ws) {
          try { this.ws.close(); } catch (e) {}
        }
        this.wsAlive = false;
        resolveSession({ success: true, reason, goalAchieved });
      };

      this.endCurrentSession = endSession;

      this.resetCycleTimeout = (newSeconds) => {
        if (cycleDone) return;
        if (sessionTimeout) clearTimeout(sessionTimeout);
        this.metrics.keepAliveSeconds = newSeconds;
        this.metrics.cycleCountdown = newSeconds;
        sessionTimeout = setTimeout(() => {
          appendLog('Heartbeat', `[${accName}][${desktopName}] 周期时间到 (${newSeconds}s)，强制重连刷新天翼云会话...`, 'info');
          endSession('Timeout Reset');
        }, newSeconds * 1000);
      };

      if (isHangMode) {
        // 挂机会话时长：主挂机 3600 秒，尾差补挂按传入轮次时长 (上限 3600 秒)；轻量认领脉冲 (如打卡 <=30秒) 允许精准按传入时长执行 (下限 15 秒)
        const minSec = pulseConnectSec <= 30 ? Math.max(15, pulseConnectSec) : 60;
        const maxHangTimeout = Math.min(3600, Math.max(minSec, parseInt(pulseConnectSec) || 3600));
        this.metrics.keepAliveSeconds = maxHangTimeout;
        this.metrics.cycleCountdown = maxHangTimeout;
        const timeoutLabel = goalTaskName ? '任务认领观察' : '挂机长连接看门狗';
        sessionTimeout = setTimeout(() => {
          appendLog('Heartbeat', `[${accName}][${desktopName}] ${timeoutLabel}周期到 (${maxHangTimeout}s)，平滑刷新会话...`, 'info');
          endSession(goalTaskName ? 'Sign Watchdog' : 'Hang Watchdog');
        }, maxHangTimeout * 1000);
      } else {
        const connectSec = Math.min(60, Math.max(15, pulseConnectSec));
        this.metrics.keepAliveSeconds = connectSec;
        this.metrics.cycleCountdown = connectSec;
        sessionTimeout = setTimeout(() => {
          appendLog('Heartbeat', `[${accName}][${desktopName}] 脉冲握手完成 (${connectSec}s)，释放通道待机...`, 'info');
          endSession('Pulse Finished');
        }, connectSec * 1000);
      }

      if (this.countdownTimer) clearInterval(this.countdownTimer);
      this.countdownTimer = setInterval(() => {
        if (this.metrics.cycleCountdown > 0) {
          this.metrics.cycleCountdown--;
        }
      }, 1000);

      this.ws = new WebSocket(wsUrl, {
        headers: { Origin: 'https://pc.ctyun.cn' },
        agent: wsProxyAgent,
        rejectUnauthorized: false
      });

      const safeSend = (data) => {
        try {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(data);
          }
        } catch (err) {
          appendLog('Heartbeat', `[${accName}][${desktopName}] 报文发送异常: ${err.message}`, 'warning');
        }
      };

      this.ws.on('open', () => {
        wsConnectedAt = Date.now();
        this.sessionConflictStreak = 0;
        this.conflictRetryUntil = 0;
        this.wsAlive = true;
        this.metrics.status = 'online';

        // 当日成功轮次按自然日 0 点重置统计
        const todayStr = getBeijingDateOnly();
        if (this.lastSuccessDate !== todayStr) {
          this.metrics.successCount = 0;
          this.lastSuccessDate = todayStr;
        }
        this.metrics.successCount++;
        this.account.stats = this.account.stats || {};
        this.account.stats.todaySuccessCount = this.metrics.successCount;
        this.account.stats.lastSuccessDate = todayStr;
        this.account.stats.keepAliveStatus = 'online';
        saveConfig(appConfig);

        appendLog('Heartbeat', `[${accName}][${desktopName}] 🟢 保活长连接就绪 (${this.metrics.currentHost})`, 'success');

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
          appendLog('Heartbeat', `[${accName}][${desktopName}] 已发送保活特征码报文 (UkVEUQIA...)`, 'info');
        }, 500);
      });

      this.ws.on('message', (data) => {
        try {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          const hex = buf.toString('hex').toUpperCase();

          this.wsAlive = true;
          this.metrics.status = 'online';
          if (this.account.stats) this.account.stats.keepAliveStatus = 'online';

          if (hex.startsWith('52454451')) {
            const nowStr = getBeijingTimeOnly();
            redqCount++;
            appendLog('Heartbeat', `[${accName}][${desktopName}] 收到服务端保活校验 REDQ (${buf.length}B)`, 'info');

            const responseBuf = this.encryptor.execute(buf);
            safeSend(responseBuf);

            this.metrics.lastHeartbeatTime = nowStr;
            this.metrics.lastHeartbeatResult = `[${desktopName}] REDQ 校验成功，已回传 ${responseBuf.length} 字节加密应答 (${nowStr})`;
            appendLog('Heartbeat', `[${accName}][${desktopName}] -> ✅ 成功回传 RSA-OAEP 加密应答 (${responseBuf.length}B)`, 'success');
            return;
          }

          if (buf.length >= 6) {
            const type = buf.readUInt16LE(0);
            const size = buf.readUInt32LE(2);

            if (type === 4) {
              const pongBuf = Buffer.alloc(6 + Math.min(size, 12));
              pongBuf.writeUInt16LE(3, 0);
              pongBuf.writeUInt32LE(Math.min(size, 12), 2);
              if (size > 0 && buf.length >= 6 + Math.min(size, 12)) {
                buf.copy(pongBuf, 6, 6, 6 + Math.min(size, 12));
              }
              safeSend(pongBuf);
              return;
            }

            if (type === 3 && size >= 8) {
              const gen = buf.readUInt32LE(6);
              const ackBuf = Buffer.alloc(10);
              ackBuf.writeUInt16LE(1, 0);
              ackBuf.writeUInt32LE(4, 2);
              ackBuf.writeUInt32LE(gen, 6);
              safeSend(ackBuf);
              return;
            }

            if (type === 103) {
              handshakeDone = true;
              appendLog('Heartbeat', `[${accName}][${desktopName}] 收到云电脑 103 认证，正在上报 118 用户身份...`, 'info');
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
              appendLog('Heartbeat', `[${accName}][${desktopName}] -> ✅ 已回传 118 身份 (用户ID: ${this.loginInfo.userId})，在线状态已激活！`, 'success');

              if (isHangMode) {
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
                  msgBuf112.writeUInt16LE(112, 0);
                  msgBuf112.writeUInt32LE(dataSize, 2);
                  dataBuf.copy(msgBuf112, 6);

                  safeSend(msgBuf112);
                } catch (e) {}

                try {
                  const msgBuf104 = Buffer.alloc(6);
                  msgBuf104.writeUInt16LE(104, 0);
                  msgBuf104.writeUInt32LE(0, 2);
                  safeSend(msgBuf104);
                  claimSent = true;
                } catch (e) {}
              } else {
                appendLog('Heartbeat', `[${accName}][${desktopName}] 脉冲旁观者模式已激活：不认领桌面会话 (无 112/104)，官方客户端随时接入永不被踢。`, 'info');
              }

              if (this.clinkPingTimer) clearInterval(this.clinkPingTimer);
              this.clinkPingTimer = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                  const hbBuf = Buffer.alloc(6);
                  hbBuf.writeUInt16LE(7, 0);
                  hbBuf.writeUInt32LE(0, 2);
                  safeSend(hbBuf);
                }
              }, 5000);

              if (isHangMode || goalTaskName) {
                const watchTaskName = goalTaskName || '使用1小时';
                const isGoalHang = !goalTaskName; // 未指定目标 = 经典挂机 (1 小时)
                const checkGoalProgress = async () => {
                  if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
                  await this.refreshOfficialTasks();
                  const goalTask = this.metrics.officialTasks?.find(t => t.name.includes(watchTaskName));
                  const curSec = goalTask ? (goalTask.current || 0) : 0;
                  const totSec = goalTask ? (goalTask.total || 3600) : 3600;

                  if (goalTask && (goalTask.status === 2 || (totSec > 0 && curSec >= totSec))) {
                    if (hangCheckInterval) clearInterval(hangCheckInterval);
                    if (isGoalHang) {
                      appendLog('KeepAlive', `[${accName}][${desktopName}] 🎉 恭喜！今日使用 AI 云电脑 1 小时挂机任务已圆满达成 (+100积分)！后台长连接立即主动让位关闭，转入脉冲保活防休眠模式。`, 'success');
                      sendAccountNotification(
                        this.account,
                        `🎉 挂机1小时任务达成 - ${accName}`,
                        `账号【${accName}】今日使用 AI 云电脑达到 1 小时任务已完成，100 积分已入账！`
                      );
                      endSession('Today Hang Goal Achieved');
                    } else {
                      goalAchieved = true;
                      appendLog('Sign', `[${accName}][${desktopName}] 🎉 官方任务中心已实时确认【${watchTaskName}】达成 (+100积分)！登录打卡已真实完成！`, 'success');
                      endSession('Sign Goal Achieved');
                    }
                  } else if (isGoalHang) {
                    const curMin = Math.floor(curSec / 60);
                    const totMin = Math.floor(totSec / 60);
                    const remainSec = Math.max(0, totSec - curSec);
                    this.metrics.lastHeartbeatResult = `[${desktopName}] 挂机累加中: 已在线 ${curMin}/${totMin} 分钟 (${curSec}/${totSec}秒，剩余约 ${Math.ceil(remainSec / 60)} 分钟)`;
                    this.metrics.cycleCountdown = remainSec;
                  } else {
                    this.metrics.lastHeartbeatResult = `[${desktopName}] 桌面登录认领保持中，等待官方任务中心确认【${watchTaskName}】...`;
                    this.metrics.cycleCountdown = Math.max(0, Math.round((totSec - curSec) / 1000));
                  }
                };

                setTimeout(checkGoalProgress, 2500);
                hangCheckInterval = setInterval(checkGoalProgress, 15000);
              } else {
                this.metrics.lastHeartbeatResult = `[${desktopName}] 脉冲保活握手就绪，已向网关发送 REDQ/心跳`;
              }
            }

            if (type === 119 || type === 120 || type === 137) {
              // 官方客户端在席信令：真机用户已接入。挂机模式下若随后被断开，据此判定为真实抢占而非网络闪断
              clientPresenceSignal = true;
              appendLog('Heartbeat', `[${accName}][${desktopName}] 收到客户端在席信令 (${type})，官方客户端已接入使用。`, 'info');
              return;
            }
          }
        } catch (err) {
          appendLog('Heartbeat', `[${accName}][${desktopName}] 解析报文异常: ${err.message}`, 'warning');
        }
      });

      this.ws.on('error', (err) => {
        appendLog('Heartbeat', `[${accName}][${desktopName}] 通道异常: ${err.message || '连接受阻'}`, 'error');
        this.metrics.errorCount++;
        endSession('Socket Error');
      });

      this.ws.on('close', (code, reason) => {
        const reasonStr = String(reason || '');
        const heldSec = wsConnectedAt ? Math.floor((Date.now() - wsConnectedAt) / 1000) : 0;

        // 诊断埋点 (零行为改动)：非自身主动关闭时，完整留存判定「真机抢占 vs 网络抖动」所需的全部证据。
        // 若本行显示"在席信令=无 且 code 未达 4000"，却判定为网络抖动而重连，即为 45 秒循环踢人的直接证据。
        if (!isClosingSelf) {
          appendLog('Heartbeat', `[${accName}][${desktopName}] [断开诊断] code=${code} reason="${reasonStr || '(空)'}" 保持=${heldSec}s | 在席信令(119/120/137)=${clientPresenceSignal ? '有' : '无'} 103握手=${handshakeDone ? '已完成' : '未完成'} 112/104认领=${claimSent ? '已发送' : '未发送'} REDQ应答=${redqCount}次 | 模式=${isHangMode ? '挂机认领' : (goalTaskName || '脉冲旁观')}`, 'warning');
        }

        if (isClosingSelf) {
          appendLog('Heartbeat', `[${accName}][${desktopName}] 保活长连接正常轮转关闭 (${code} - ${reason || '周期重连'})`, 'info');
          return;
        }

        // 证据充分：网关明确抢占 (code>=4000 / reason 含 preempt|kick|conflict)
        if (code >= 4000 || reasonStr.includes('preempt') || reasonStr.includes('kick') || reasonStr.includes('conflict')) {
          appendLog('Heartbeat', `[${accName}][${desktopName}] 收到网关抢占信令 (${code})，确认为官方客户端接入信号。`, 'info');
          endSession('Preempted by Client');
          return;
        }

        // 证据充分：断开前收到过 Type 119/120/137 在席信令 → 真机接入导致的踢线
        if (clientPresenceSignal) {
          appendLog('Heartbeat', `[${accName}][${desktopName}] 断开前收到官方客户端在席信令，判定为真机接入抢占 (状态码: ${code}，已保持 ${heldSec} 秒)。`, 'info');
          endSession('Preempted by Client');
          return;
        }

        // ── 兜底路径：断开但【没有任何】客户端在席证据 ──────────────────────────────
        // 历史缺陷 (暗线 B)：此处原先直接判定为「网络/网关抖动」，随后无条件 45 秒重连续跑，
        // 导致真实用户被反复顶掉。根因是"没有证据"被当成了"没有用户"的证据。
        // 现在改为产出中性的 'Unverified Channel Close'，由上层 runHangTask 执行证据鉴别
        // (观察官方计时是否增长) 后再决定是否允许重新认领。
        // 在席信令机制本身的可靠性早在 2026-09-09 就被确认为"常常监听不到"，
        // 因此本分支必须假定"可能有真机用户"，而不是假定"没有"。
        appendLog('Heartbeat', `[${accName}][${desktopName}] 通道被网关断开 (状态码: ${code}，已保持 ${heldSec} 秒)，但未收到任何客户端在席证据 (无 119/120/137 且 code 未达 4000)。此事不构成"无人在用"的结论，交由上层做证据鉴别后再决定是否重连。`, 'warning');
        endSession('Unverified Channel Close');
      });
    });
  }

  /**
   * 定时挂机 1 小时任务执行器 (由 Scheduler 定时精确触发，或由用户在控制台手动点击触发)
   * 职责严格隔离：仅在定时触发时临时启动独占认领会话，挂满 1 小时后自动结束；
   * 若挂机中途被用户客户端顶掉，立即主动避让 10 分钟，绝不反复重连争抢！
   */
  async runHangTask(onLog = console.log) {
    const accName = this.account.name || this.account.user;

    // 本次任务已实际执行，先清除待触发的重试定时器 (避免重影)
    if (this.hangRetryTimer) {
      clearTimeout(this.hangRetryTimer);
      this.hangRetryTimer = null;
    }

    // 0. 账号级挂机开关：统一入口判定 (暗线 A —— 保活开关对任务零影响)
    const accHangGate = this.resolveTask('cloudHang');
    if (!accHangGate.enabled) {
      this.clearHangRetry();
      onLog('Hang', `[${accName}] ${accHangGate.reason}，本次挂机任务自动跳过。`, 'info');
      return { success: true, isCompleted: false, message: accHangGate.reason };
    }

    // 0.1 与登录打卡认领会话互斥 (新发现 #33)：这两处曾可能同时下发 Type 112/104，
    //     造成互相顶掉且官方计时不累加。打卡认领进行中时挂机一律让位并稍后重试。
    if (this._signSessionActive) {
      onLog('Hang', `[${accName}] 登录打卡认领会话正在进行中，挂机任务主动让位等待，避免双认领冲突。`, 'info');
      this.scheduleHangRetry(onLog);
      return { success: true, isCompleted: false, message: '打卡认领进行中，挂机让位' };
    }

    // 1. 检查今日挂机 1 小时是否已达成
    const initRefresh = await this.refreshOfficialTasks();
    if (this.isTodayHangTaskCompleted()) {
      this.clearHangRetry();
      onLog('Hang', `[${accName}] ✅ 今日云电脑 1 小时挂机任务已达成 (+100积分)，无需重复执行。`, 'success');
      return { success: true, isCompleted: true, message: '今日挂机时长已满 60 分钟' };
    }
    // 官方状态不可读时不得盲目开抢：认领会顶掉真实用户，而"不知道是否已完成"不构成执行理由
    if (initRefresh && initRefresh.ok === false) {
      onLog('Hang', `[${accName}] 官方任务中心暂不可读 (${initRefresh.reason})，无法确认今日达成状态。为避免盲目认领抢占，本次挂机暂缓。`, 'warning');
      this.scheduleHangRetry(onLog);
      return { success: true, isCompleted: false, message: '官方状态不可读，本次挂机暂缓' };
    }

    // 2. 检查用户与客户端避让状态 (避让后自动安排续跑，绝不静默丢弃今日任务)
    if (this.isWebUserActive && Date.now() < this.webUserActiveUntil) {
      onLog('Hang', `[${accName}] 浏览器用户正在操作云电脑，本次挂机任务主动避让。`, 'info');
      this.scheduleHangRetry(onLog);
      return { success: true, isCompleted: false, message: '用户网页操作中，主动避让' };
    }
    if (Date.now() < this.externalYieldUntil) {
      const waitMin = Math.ceil((this.externalYieldUntil - Date.now()) / 60000);
      onLog('Hang', `[${accName}] 官方客户端 (App/PC) 近期正在使用，挂机任务处于避让冷却期 (剩余 ${waitMin} 分钟)，跳过本次抢占。`, 'info');
      this.scheduleHangRetry(onLog);
      return { success: true, isCompleted: false, message: '处于客户端避让冷却期' };
    }

    // 3. 标记正在执行挂机任务，让后台脉冲循环主动让位
    this.isTaskHanging = true;
    this.metrics.isTaskHanging = true;
    this.hangReconnectCount = 0; // 单次 runHangTask 内"经证据鉴别后允许重连"的次数
    if (this.endCurrentSession) {
      this.endCurrentSession('Yield to Scheduled Hang Task');
    }

    // 硬性总时长上限：确保本函数在任何分支组合下都必然返回，
    // 杜绝历史上 attempt-- 使 MAX_ROUNDS 失效后可能出现的无限运行。
    const hangDeadline = Date.now() + 100 * 60 * 1000;
    const deadlineExceeded = () => Date.now() > hangDeadline;

    try {
      // 4. 获取目标云电脑并确保开机 (优选已在运行的主机，避免挂机落空)
      const desktops = await this.getDesktops();
      if (!desktops || desktops.length === 0) {
        onLog('Hang', `[${accName}] 账号名下暂无可用云电脑，无法执行挂机任务。`, 'warning');
        this.scheduleHangRetry(onLog);
        return { success: false, isCompleted: false, message: '名下无云电脑' };
      }

      const isDesktopRunning = (d) => d && (d.useStatusText === '运行中' || d.useStatus == 25);
      // 统一开关入口：挂机是否可作用于该机，只由 cloudHang + desktop.taskEnabled 决定
      const taskOnDesktops = desktops.filter(d => this.resolveTask('cloudHang', d).enabled);
      if (taskOnDesktops.length === 0) {
        onLog('Hang', `[${accName}] 账号名下所有云电脑的挂机任务均被开关关闭，本次挂机任务自动跳过。`, 'info');
        return { success: true, isCompleted: false, message: '名下所有云电脑均已关闭挂机任务开关' };
      }

      const runningDesktops = taskOnDesktops.filter(d => isDesktopRunning(d));
      const mainDesktop = runningDesktops[0] || taskOnDesktops[0];
      const targetName = mainDesktop.objName || mainDesktop.desktopName || '云电脑';
      const targetId = String(mainDesktop.objId || mainDesktop.desktopId);

      if (!isDesktopRunning(mainDesktop)) {
        if (mainDesktop.autoBootEnabled === false) {
          onLog('Hang', `[${accName}][${targetName}] 云电脑未开机且已关闭自动开机，跳过本次挂机任务。`, 'info');
          return { success: true, isCompleted: false, message: '云电脑未开机且已关闭自动开机' };
        }
        onLog('Hang', `[${accName}][${targetName}] 云电脑未开机，正在下发开机唤醒指令...`, 'info');
        await this.controlPower(targetId, 'poweron').catch(() => {});
        // 开机就绪轮询 (最长 120 秒)：杜绝未就绪即认领导致官方计时不累加
        let bootReady = false;
        for (let i = 0; i < 12; i++) {
          await new Promise(r => setTimeout(r, 10000));
          const fresh = await this.getDesktops().catch(() => []);
          const target = (fresh || []).find(d => String(d.objId || d.desktopId) === targetId);
          if (isDesktopRunning(target)) { bootReady = true; break; }
        }
        onLog('Hang', `[${accName}][${targetName}] 开机就绪探测: ${bootReady ? '✅ 已进入运行中状态' : '⚠️ 120 秒未确认就绪，继续尝试认领'}`, bootReady ? 'success' : 'warning');
      }

      onLog('Hang', `[${accName}][${targetName}] 🚀 定时挂机任务已启动，正在建立独占会话累加使用时长...`, 'info');

      // 5. 执行主挂机长连接 (3600 秒) + 尾差自动补挂循环：确保官方计数真正到达 60/60
      // 每一轮开始前重新校验避让状态与账号/单机开关，与多机独立纳管/客户端避让机制完全兼容：
      const USER_INTENT_STOP_REASONS = ['User Disabled Task on Active Desktop', 'User Disabled Hang Mode', 'Yield to External Client', 'Web User Active'];
      let attempt = 0;
      let lastResult = null;
      this.hangNoClaimRetries = 0; // 未建立会话 (未下发 112/104) 的快速重试计数：无顶人风险
      const MAX_ROUNDS = 4; // 1 轮主挂机 (3600s) + 最多 3 轮 10 分钟尾差补挂
      while (attempt < MAX_ROUNDS) {
        attempt++;

        // 5.0 硬性总时长上限：无论何种分支组合，本次挂机都必须在有限时间内返回
        if (deadlineExceeded()) {
          onLog('Hang', `[${accName}][${targetName}] 本次挂机已达硬性时长上限 (100 分钟)，主动收束，交回定时续跑。`, 'warning');
          this.scheduleHangRetry(onLog);
          break;
        }

        // 5.0.1 账号级挂机开关实时校验 (统一入口，暗线 A)
        const accGateNow = this.resolveTask('cloudHang');
        if (!accGateNow.enabled) {
          onLog('Hang', `[${accName}][${targetName}] ${accGateNow.reason}，挂机${attempt > 1 ? '补挂/重连' : ''}立即终止。`, 'info');
          break;
        }
        // 5.0.2 打卡认领会话进行中：让位，避免双 112/104 认领互相顶掉 (#33)
        if (this._signSessionActive) {
          onLog('Hang', `[${accName}][${targetName}] 登录打卡认领会话正在进行，挂机本轮让位终止。`, 'info');
          this.scheduleHangRetry(onLog);
          break;
        }
        // 5.1 用户浏览器正在操作云电脑：挂机立即让位终止，绝不反抢
        if (this.isWebUserActive && Date.now() < this.webUserActiveUntil) {
          onLog('Hang', `[${accName}][${targetName}] 浏览器用户正在操作云电脑，挂机${attempt > 1 ? '补挂' : ''}主动让位终止。`, 'info');
          break;
        }
        // 5.2 官方客户端避让冷却期内：终止本轮补挂 (由下一次调度再续)
        if (Date.now() < this.externalYieldUntil) {
          const waitMin = Math.ceil((this.externalYieldUntil - Date.now()) / 60000);
          onLog('Hang', `[${accName}][${targetName}] 官方客户端避让冷却期内 (剩余 ${waitMin} 分钟)，挂机${attempt > 1 ? '补挂' : ''}终止。`, 'info');
          break;
        }
        // 5.3 单机开关实时校验 (统一入口，暗线 A)
        const freshTarget = (this.account.desktops || []).find(d => String(d.objId || d.desktopId) === targetId);
        if (freshTarget) {
          const freshGate = this.resolveTask('cloudHang', freshTarget);
          if (!freshGate.enabled) {
            onLog('Hang', `[${accName}][${targetName}] ${freshGate.reason}，挂机立即终止。`, 'info');
            break;
          }
        }

        const roundSec = attempt === 1 ? 3600 : 600;
        lastResult = await this.runDesktopKeepAliveSession(mainDesktop, true, roundSec);

        const postRefresh = await this.refreshOfficialTasks();
        if (this.isTodayHangTaskCompleted()) break;

        const reasonStr = String((lastResult && lastResult.reason) || '');

        // 5.4 用户意图中断 (单机关闭/客户端避让/浏览器接入)：直接终止，不再补挂
        if (USER_INTENT_STOP_REASONS.includes(reasonStr)) {
          onLog('Hang', `[${accName}][${targetName}] 挂机会话因避让或用户操作中断 (${reasonStr})，终止补挂。`, 'info');
          break;
        }

        // 5.5 网关抢占信令 (code>=4000 / 在席信令)：官方客户端接入的确凿证据，让位 10 分钟
        if (reasonStr === 'Preempted by Client') {
          if (!this.isWebUserActive && Date.now() >= this.externalYieldUntil) {
            this.yieldToExternalClient(10);
            onLog('Hang', `[${targetName}] ⚠️ 收到网关抢占信令，确认官方客户端接入，已让位避让 10 分钟，绝不反抢！`, 'warning');
          }
          break;
        }

        // 5.6 未建立会话即未认领：从未下发 112/104，不存在顶人风险，允许有限次快速重试
        if (reasonStr === 'no_gateway') {
          this.hangNoClaimRetries = (this.hangNoClaimRetries || 0) + 1;
          if (this.hangNoClaimRetries > 3) {
            onLog('Hang', `[${targetName}] 网关迟迟未分配通道 (已尝试 ${this.hangNoClaimRetries} 次)，转入定时自动续跑。`, 'info');
            this.scheduleHangRetry(onLog);
            break;
          }
          onLog('Hang', `[${targetName}] 视讯网关尚未分配通道 (本次未认领桌面，无顶人风险)，30 秒后重试 (${this.hangNoClaimRetries}/3)...`, 'info');
          await new Promise(r => setTimeout(r, 30000));
          continue;
        }

        // ─────────────────────────────────────────────────────────────────────
        // 5.7 统一的中断处置：凡"已被断开、可能重连"的情形，一律先做证据鉴别再决定是否认领。
        //     历史缺陷 (暗线 B)：'Closed' 与 'Socket Error' 曾被直接判定为「网络/网关抖动」，
        //     并在 45 秒后无条件重新认领 → 把真实用户反复顶下线。
        //     根因是"没有在席证据"被当成了"没有用户"。此处必须假定可能有真人。
        // ─────────────────────────────────────────────────────────────────────
        const RECONNECTABLE_REASONS = ['occupied', 'Unverified Channel Close', 'Closed', 'Socket Error'];
        if (RECONNECTABLE_REASONS.includes(reasonStr)) {
          const verdict = await this.diagnoseHangInterruption(onLog, targetName, postRefresh);
          if (verdict === 'completed') break;

          // real_client / unverified 一律不得重新认领：
          //   real_client = 有真人在使用 (官方计时仍在增长)
          //   unverified  = 取不到可信证据 → 按"可能有真人"处理 (判定方向不对称，见函数注释)
          if (verdict === 'real_client' || verdict === 'unverified') {
            if (verdict === 'unverified') {
              this.hangUnverifiedStreak++;
              if (this.hangUnverifiedStreak >= 3) {
                onLog('Hang', `[${targetName}] 已连续 ${this.hangUnverifiedStreak} 次无法取得可信证据，为杜绝任何形式的抢占，本次挂机转入长冷却 (30 分钟)。`, 'warning');
                this.yieldToExternalClient(30);
                break;
              }
            } else {
              this.hangUnverifiedStreak = 0;
            }
            if (!this.isWebUserActive && Date.now() >= this.externalYieldUntil) {
              this.yieldToExternalClient(10);
              onLog('Hang', `[${targetName}] ⚠️ ${verdict === 'real_client' ? '证据显示官方客户端正在使用 (计时仍增长)' : '取不到可信证据 (按可能存在客户端处理)'}，已让位避让 10 分钟，绝不反抢！`, 'warning');
            }
            break;
          }

          // 到此 verdict === 'false_alarm'：官方计时冻结，确认无人在用，允许重连
          this.hangUnverifiedStreak = 0;
          this.hangReconnectCount++;
          if (this.hangReconnectCount > 3) {
            onLog('Hang', `[${targetName}] 本次挂机的证据式重连已用满 3 次，转入定时续跑 (避免长尾循环)。`, 'info');
            this.scheduleHangRetry(onLog);
            break;
          }
          attempt--; // 不占用补挂轮次预算；轮次预算由 hangReconnectCount 与 100 分钟硬上限共同约束
          onLog('Hang', `[${targetName}] ✅ 证据鉴别通过：官方计时冻结，确认无客户端在用 (断开原因: ${reasonStr})，60 秒后重连续挂 (${this.hangReconnectCount}/3)...`, 'info');
          await new Promise(r => setTimeout(r, 60000));
          continue;
        }

        if (attempt < MAX_ROUNDS) {
          onLog('Hang', `[${targetName}] 官方计时尚未达 60 分钟 (主挂机轮次 ${attempt} 结束)，正在自动补挂尾差...`, 'info');
        }
      }

      await this.refreshOfficialTasks();
      const isDone = this.isTodayHangTaskCompleted();
      if (isDone) {
        this.clearHangRetry();
        onLog('Hang', `[${accName}][${targetName}] 🎉 今日 1 小时挂机任务已圆满达成 (+100积分)！`, 'success');
      } else {
        // 未达标的自愈续跑：静默等待冷却后自动重试，绝不把今日任务丢给明天
        this.scheduleHangRetry(onLog);
      }
      return {
        success: true,
        isCompleted: isDone,
        message: isDone ? '今日 1 小时挂机任务已圆满达成！' : '本次挂机阶段已结束'
      };
    } finally {
      this.isTaskHanging = false;
      this.metrics.isTaskHanging = false;
    }
  }

  async runCycleLoop() {
    const accName = this.account.name || this.account.user;

    while (this.workerRunning) {
      try {
        const kaGate = this.resolveTask('keepAlive');
        if (!kaGate.enabled) {
          appendLog('KeepAlive', `[${accName}] ${kaGate.reason}，守护循环退出。`, 'info');
          this.stopKeepAliveWorker();
          break;
        }

        if (this.account.sessionExpired || !this.loginInfo) {
          this.metrics.status = 'offline';
          this.metrics.lastHeartbeatResult = '⚠️ 登录会话已过期，请在卡片点击【重新验证】输入验证码！';
          if (this.account.stats) this.account.stats.keepAliveStatus = 'offline';
          await new Promise(r => setTimeout(r, 15000));
          continue;
        }

        // 如果 Scheduler 正在执行独占挂机任务，或登录打卡认领会话进行中，常态保活循环主动避让等待
        if (this.isTaskHanging || this._signSessionActive) {
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

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

        // 定期主动无感续期 (每 12 小时静默轮转刷新一次 Token 凭据，确保持久常驻不失效)
        if (!this.lastTokenRenewAt || (Date.now() - this.lastTokenRenewAt > 12 * 3600 * 1000)) {
          this.renewToken().then(() => {
            this.lastTokenRenewAt = Date.now();
          }).catch(() => {});
        }

        // 1. 查询名下全部云电脑
        const desktops = await this.getDesktops();
        if (!desktops || desktops.length === 0) {
          appendLog('KeepAlive', `[${accName}] 账号名下暂无可用云电脑，60秒后重试...`, 'warning');
          this.metrics.status = 'offline';
          this.metrics.lastHeartbeatResult = '名下无云电脑';
          await new Promise(r => setTimeout(r, 60000));
          continue;
        }

        // 2. 遍历名下所有云电脑，检查开机/休眠状态并自动唤醒未启动机器 (多机独立守护过滤)
        let hasWokenAny = false;
        for (const d of desktops) {
          if (!this.resolveTask('keepAlive', d).enabled) continue; // 统一入口：账号级/单机保活开关
          const isAutoBootAllowed = d.autoBootEnabled !== false;
          const isRunning = d && (d.useStatusText === '运行中' || d.useStatus == 25);
          const dId = d.objId || d.desktopId;
          const dName = d.objName || d.desktopName || '云电脑';
          if (!isRunning && isAutoBootAllowed) {
            if (!this.account.manualShutdown) {
              const isDormant = (d.useStatusText || '').includes('休眠') || (d.useStatusText || '').includes('睡眠');
              const actionTarget = isDormant ? 'awake' : 'poweron';
              const actionCn = isDormant ? '唤醒' : '开机';
              appendLog('KeepAlive', `[${accName}][${dName}] 处于 [${d.useStatusText || '未启动'}] 状态，自动下发${actionCn}指令...`, 'info');
              await this.controlPower(dId, actionTarget).catch(() => {});
              hasWokenAny = true;
            }
          }
        }
        if (hasWokenAny) {
          appendLog('KeepAlive', `[${accName}] 已为名下未启动云电脑下发唤醒开机指令，等待启动就绪 (25秒后探测)...`, 'info');
          await new Promise(r => setTimeout(r, 25000));
          continue;
        }

        // 3. 运行中云电脑常态保活 (多机高精度独立时间戳轮转引擎，100% 旁观者脉冲防休眠)
        this.bootWaitStartTime = null;
        this.metrics.status = 'online';
        if (this.account.stats) this.account.stats.keepAliveStatus = 'online';

        const defaultPulseGapSec = Math.min(3300, Math.max(10, parseInt(this.account.pulseIntervalSeconds || appConfig.settings?.pulseIntervalSeconds) || 30));
        const pulseConnectSec = Math.min(60, Math.max(15, appConfig.settings?.keepAliveSeconds || 20));

        const now = Date.now();
        for (const d of desktops) {
          if (!this.workerRunning || this.isTaskHanging) break;
          if (!this.resolveTask('keepAlive', d).enabled) continue; // 统一入口：账号级/(该机)独立保活开关

          // 获取该台天翼云电脑的独立脉冲周期 (未单独指定则继承账号/系统全局默认)
          const dIntervalSec = Math.min(3300, Math.max(10, parseInt(d.keepaliveInterval) || defaultPulseGapSec));
          const lastPulse = d.lastPulseAt || 0;
          const elapsedSec = Math.floor((now - lastPulse) / 1000);

          // 时间未到达该主机的专属脉冲周期，继续休眠跳过
          if (lastPulse > 0 && elapsedSec < dIntervalSec) {
            continue;
          }

          const isRunning = d && (d.useStatusText === '运行中' || d.useStatus == 25);
          if (isRunning) {
            this.metrics.desktopId = d.objId || d.desktopId;
            this.metrics.desktopName = d.objName || d.desktopName || '云电脑';
            appendLog('KeepAlive', `[${accName}][${this.metrics.desktopName}] 触发脉冲保活握手 (独立周期: ${dIntervalSec}秒)...`, 'info');
            await this.runDesktopKeepAliveSession(d, false, pulseConnectSec);
            d.lastPulseAt = Date.now();
          }
        }

        // 计算所有有效保活主机的最短剩余倒计时，供前端看板实时呈现
        const activeDesktops = desktops.filter(d => d.keepaliveEnabled !== false);
        if (activeDesktops.length > 0) {
          const nowTs = Date.now();
          const countdowns = activeDesktops.map(d => {
            const dInterval = Math.min(3300, Math.max(10, parseInt(d.keepaliveInterval) || defaultPulseGapSec));
            const elapsed = Math.floor((nowTs - (d.lastPulseAt || 0)) / 1000);
            return Math.max(0, dInterval - elapsed);
          });
          this.metrics.cycleCountdown = Math.min(...countdowns);
        } else {
          this.metrics.cycleCountdown = defaultPulseGapSec;
        }

        // 高精度时间轮时钟片休眠 (每 10 秒轮转一次)
        let waited = 0;
        const tickStep = 10;
        while (waited < tickStep && this.workerRunning && !this.isTaskHanging) {
          if (this.account.sessionExpired) break;
          if (this.isWebUserActive && Date.now() >= this.webUserActiveUntil) {
            this.isWebUserActive = false;
          }
          if (this.isWebUserActive && Date.now() < this.webUserActiveUntil) {
            this.metrics.lastHeartbeatResult = '浏览器用户操作中，脉冲计时已暂停';
            await new Promise(r => setTimeout(r, 5000));
            continue;
          }
          await new Promise(r => setTimeout(r, 1000));
          waited += 1;
        }

        await this.refreshOfficialTasks().catch(() => {});

      } catch (err) {
        appendLog('KeepAlive', `[${accName}] 保活异常: ${err.message}，10秒后重试...`, 'error');
        this.metrics.status = 'offline';
        this.metrics.lastHeartbeatResult = `异常: ${err.message}`;
        this.account.stats.keepAliveStatus = 'offline';
        saveConfig(appConfig);

        sendAccountNotification(
          this.account,
          `⚠️ 天翼云保活中断告警 - ${accName}`,
          `账号 [${accName}] 的云电脑长连接中断: ${err.message}，守护程序正在自动拉起重试。`
        );

        await new Promise(r => setTimeout(r, 10000));
      }
    }
  }
}

const clientInstances = new Map();

// ----------------------------------------------------------
// 移动公众（ecloud）账号默认开关
// ----------------------------------------------------------
// L1/L2 默认开。【2026-09-26 用户拍板】L3（SPICE 心跳）从未实现，整层删除（UI 到底层）。
function buildEcloudDefaultFeatures() {
  return {
    keepAlive: true,              // 账号级保活总开关（与另两平台同名同义，但账号存储各自独立）
    ecloudL1AccountKeep: true,    // L1 账号态保活
    ecloudL2DesktopReg: true,     // L2 桌面登记保活
    // 【2026-09-28 用户拍板】平台存在约 48 小时强制关机策略，自动开机守护**默认开启**
    // （拦不住强制关机就自动恢复）；不需要的用户可显式关闭。
    autoBoot: true
  };
}

// ----------------------------------------------------------
// 移动公众「两段式登录」的待定会话表
// ----------------------------------------------------------
// 移动公众登录可能要求短信验证码（设备信任 / 双因素 / 增强短信），后台无法代答。
// 这里暂存"已登录一半"的会话（会话本体在 Python 侧车内），等验证码回来接着完成。
const pendingEcloudLogins = new Map();
const ECLOUD_PENDING_TTL_MS = 15 * 60 * 1000;

function registerPendingEcloudLogin(id, entry) {
  const now = Date.now();
  for (const [k, v] of pendingEcloudLogins) {
    if (now - v.createdAt > ECLOUD_PENDING_TTL_MS) {
      try { v.client.stop(v.force === true); } catch (e) { /* 过期清理不抛 */ }
      pendingEcloudLogins.delete(k);
    }
  }
  pendingEcloudLogins.set(id, { ...entry, createdAt: now });
}

/**
 * 把"已通过认证的草稿账号"正式落库，并**复用**已经建立会话的客户端实例
 * （若重新 getClient 会拉起第二个侧车进程，会话就丢了 → 又要重新登录并可能再要验证码）。
 */
function finalizeEcloudAccount(acc, client) {
  appConfig.accounts.push(acc);
  client.account = acc;
  client.sessionId = acc.id;
  clientInstances.set(acc.id, client);
  saveConfig(appConfig);
  client.startKeepAliveWorker();
  return acc;
}

function getClient(acc) {
  if (!clientInstances.has(acc.id)) {
    let client;
    if (acc.platform === 'ecloud') {
      // 移动公众：独立侧车（Python 协议内核）托管，与另两平台的保活实现零共享
      client = new EcloudClient(acc, {
        appendLog,
        sendNotification: sendAccountNotification,
        saveConfig: () => saveConfig(appConfig),
        // 开关判定转发到本文件的权威入口，ecloud 侧不自己解释 features（避免第二套真相）
        resolveTaskEnabled: (account, desktop, taskType) => resolveTaskEnabled(account, desktop, taskType)
      });
      // 首次接入：尝试恢复/建立会话并同步桌面列表（失败不阻塞进程启动）
      client.refreshDesktops().catch(() => {});
    } else if (acc.platform === 'ydpc') {
      client = new YdpcClient(acc, {
        appendLog,
        sendNotification: sendAccountNotification,
        saveConfig: () => saveConfig(appConfig)
      });
      client.refreshVms().catch(() => {});
    } else {
      client = new CtYunClient(acc);
      // 立即执行一次官方任务与积分及云电脑硬件规格列表的精准拉取
      client.getDesktops().catch(() => {});
      client.refreshOfficialTasks().catch(() => {});
    }
    clientInstances.set(acc.id, client);
  } else {
    clientInstances.get(acc.id).account = acc;
  }
  return clientInstances.get(acc.id);
}

function initAllKeepAlive() {
  for (const acc of appConfig.accounts) {
    if (acc.enabled && acc.features?.keepAlive !== false) {
      const client = getClient(acc);
      if (acc.platform === 'ydpc') {
        client.refreshVms().then(() => client.startKeepAliveWorker()).catch(() => {});
      } else if (acc.platform === 'ecloud') {
        client.refreshDesktops().then(() => client.startKeepAliveWorker()).catch(() => {});
      } else {
        client.startKeepAliveWorker();
      }
    }
  }
}

if (require.main === module) {
  setTimeout(initAllKeepAlive, 2000);
}

// 初始化定时任务调度中心
const taskScheduler = new TaskScheduler({
  getAccounts: () => appConfig.accounts,
  getSettings: () => appConfig.settings,
  getClient: (acc) => getClient(acc),
  appendLog: (src, msg, lvl) => appendLog(src, msg, lvl),
  sendNotification: (target, title, content, extraVars = {}) => {
    // 账号级通知：定向推送到账号所有者
    if (target && target.ownerId) {
      return sendAccountNotification(target, title, content, extraVars);
    }
    // 全局汇总通知：按机主分别派发各自账号的汇总
    const userMap = new Map();
    for (const acc of appConfig.accounts || []) {
      const ownerId = acc.ownerId || 'u_admin';
      if (!userMap.has(ownerId)) userMap.set(ownerId, []);
      userMap.get(ownerId).push(acc);
    }
    for (const [ownerId, accList] of userMap.entries()) {
      const owner = (appConfig.users || []).find(u => u.id === ownerId);
      let targetNotify = owner?.notify;
      if ((!targetNotify || !targetNotify.enabled) && owner?.role === 'admin') {
        targetNotify = appConfig.settings?.notify;
      }
      if (targetNotify && targetNotify.enabled) {
        sendNotification({ notify: targetNotify }, title, content, extraVars).catch(() => {});
      }
    }
  },
  saveConfig: () => saveConfig(appConfig)
});
if (require.main === module) {
  setTimeout(() => taskScheduler.start(), 3000);
}

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
      let content = data;
      // 若返回 HTML，动态将当前最新的系统主标题与副标题注入模板，杜绝页面刷新时回跳闪烁！
      if (contentType.includes('text/html')) {
        let htmlStr = data.toString('utf8');
        const currentTitle = appConfig.settings?.systemTitle || '天翼云/移动云电脑保活签到中心';
        const currentSubtitle = appConfig.settings?.systemSubtitle || '多账号长连接保活守护 · 多运营商支持 · 每日签到打卡 · 智能挂机';
        htmlStr = htmlStr.replace(/<h1 id="main-system-title">[^<]*<\/h1>/, `<h1 id="main-system-title">${currentTitle}<\/h1>`);
        htmlStr = htmlStr.replace(/(<p style="font-size: 13px; color: var\(--text-muted\); margin-top: 2px;">)[^<]*(<\/p>)/, `$1${currentSubtitle}$2`);
        htmlStr = htmlStr.replace(/<title>[^<]*<\/title>/, `<title>${currentTitle} - 多账号保活控制台<\/title>`);
        content = Buffer.from(htmlStr, 'utf8');
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store, must-revalidate'
      });
      res.end(content);
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

  // 判断商品是否需要绑定云电脑
function rewardNeedsDesktop(prodId, prodType) {
  const pId = Number(prodId);
  if ([17023101, 17023111, 17024101, 17026101, 17026111].includes(pId)) {
    return true;
  }
  const typeLower = String(prodType || '').toLowerCase().trim();
  if (typeLower === 'pointstplupgrade' || typeLower === 'pointsdiskupgrade') {
    return true;
  }
  return false;
}
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
      const requestedDesktopId = parsedUrl.searchParams.get('desktopId');
      let desktop = desktops[0];
      if (requestedDesktopId) {
        const matched = desktops.find(d => String(d.objId || d.desktopId) === String(requestedDesktopId));
        if (matched) desktop = matched;
      }
      const objId = desktop.objId || desktop.desktopId;
      const b64Id = Buffer.from(String(objId)).toString('base64');

      // 核心避让机制：用户准备打开浏览器独立操作云电脑，后台长连接保活自动断开让位
      // 杜绝“AI云电脑在其他地方登录，您已被强制下线”的互踢冲突！
      client.yieldToWebUser(60);

      const authDataObj = {
        ...client.loginInfo,
        logined: true,
        userId: client.loginInfo?.userId,
        userName: client.loginInfo?.userName,
        userEid: client.loginInfo?.userEid || '',
        userAccount: client.loginInfo?.userAccount || '',
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
    localStorage.setItem('judgeUserEId', authData.userEid || '');
    localStorage.setItem('loginAt', Date.now().toString());
    sessionStorage.setItem('authExpiredAt', expiredAt);
    sessionStorage.setItem('authData', JSON.stringify(authData));
    sessionStorage.setItem('user_name', authData.userName || '');
    sessionStorage.setItem('userId', String(authData.userId || ''));
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

  // 6. 移动端横屏沉浸式全屏视图注入 (CSS + 屏幕旋转自适应与触控手势防阻断)
  const isMobileView = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768;
  if (isMobileView) {
    const mobileStyle = document.createElement('style');
    mobileStyle.innerHTML = \`
      html, body {
        width: 100vw !important;
        height: 100vh !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
        background: #000000 !important;
        touch-action: none !important;
        -webkit-user-select: none !important;
        user-select: none !important;
      }
      #app, .desktop-container, canvas, video {
        width: 100vw !important;
        height: 100vh !important;
        max-width: 100vw !important;
        max-height: 100vh !important;
        object-fit: contain !important;
      }
    \`;
    document.head.appendChild(mobileStyle);

    // 请求全屏与横屏锁定 (若移动端浏览器支持)
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock('landscape').catch(() => {});
    }
  }

  // 7. 前台网页生命周期与心跳保活双向感知感知探针
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

      html = html.replace('<head>', '<head><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover"><title>天翼云电脑 - ' + (acc.name || acc.user) + '</title>' + injectScript);
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
    serveStatic(res, path.join(STATIC_DIR, 'index.html'), 'text/html');
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
    const remember = body.remember === true; // "30 天内免登录"勾选 ⇒ 会话落盘 + 前端持久存储
    const result = authManager.login(body.username, body.password, remember);
    if (result.success) {
      appendLog('Auth', `用户 [${body.username}] 登录成功${remember ? '（已勾选 30 天内免登录）' : ''}`, 'info');
      jsonResponse(res, result);
    } else {
      jsonResponse(res, result, 400);
    }
    return;
  }

  // 登出：显式销毁会话（免登录会话必须同时从磁盘清除，否则重启后仍有效）。
  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const session = getSessionFromReq(req);
    if (session && session.token) {
      authManager.destroySession(session.token);
      appendLog('Auth', `用户 [${session.username}] 已退出登录（会话已吊销）`, 'info');
    }
    jsonResponse(res, { success: true, message: '已退出登录' });
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

  // 个人修改头像
  if (req.method === 'POST' && pathname === '/api/auth/change-avatar') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未登录' }, 401);
      return;
    }
    const body = await parseJsonBody(req);
    const newAvatar = (body.avatar || '').trim();
    if (!newAvatar) {
      jsonResponse(res, { error: '头像内容不能为空' }, 400);
      return;
    }
    const ok = authManager.updateUserAvatar(session.userId, newAvatar);
    if (ok) {
      appendLog('Auth', `用户 [${session.username}] 更新了个性化头像: ${newAvatar}`, 'info');
      jsonResponse(res, { success: true, avatar: newAvatar });
    } else {
      jsonResponse(res, { error: '用户不存在' }, 404);
    }
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
    const oldUsername = session.username;
    const updateRes = authManager.updateAdminUsername(oldUsername, newUsername);
    if (updateRes.success) {
      appendLog('Auth', `管理员用户名已从 [${oldUsername}] 修改为 [${newUsername}]`, 'warning');
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
        systemTitle: appConfig.settings?.systemTitle || '天翼云/移动云电脑保活签到中心',
        systemSubtitle: appConfig.settings?.systemSubtitle || '多账号长连接保活守护 · 多运营商支持 · 每日签到打卡 · 智能挂机',
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          maxQuota: user.maxQuota,
          avatar: user.avatar || '',
          accountsCount
        }
      });
    } else {
      // 默认提供全局未登录或 admin 访客视图
      jsonResponse(res, {
        isLoggedIn: false,
        allowRegistration: appConfig.settings?.allowRegistration === true,
        defaultQuota: appConfig.settings?.defaultQuota || 2,
        systemTitle: appConfig.settings?.systemTitle || '天翼云/移动云电脑保活签到中心',
        systemSubtitle: appConfig.settings?.systemSubtitle || '多账号长连接保活守护 · 多运营商支持 · 每日签到打卡 · 智能挂机'
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
    // 汇总该用户可见账号的今日已获得总积分 (仅统计天翼云电脑账号，移动云无积分体系)
    let totalTodayEarned = 0;
    const pointsDetails = [];

    for (const a of visibleAccounts) {
      // 严格过滤：移动云电脑 / 移动公众均无积分与任务中心，直接跳过积分统计与明细展示
      if (a.platform === 'ydpc' || a.platform === 'ecloud') continue;

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
      if (client.lastSuccessDate) {
        const todayStr = getBeijingDateOnly();
        if (client.lastSuccessDate !== todayStr) {
          client.metrics.successCount = 0;
          client.lastSuccessDate = todayStr;
          if (acc.stats) {
            acc.stats.todaySuccessCount = 0;
            acc.stats.lastSuccessDate = todayStr;
          }
        }
      }

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
      if (acc.platform === 'ecloud') {
        // 移动公众：逐台**序列化时现算**保活视图（倒计时/最近动作必须现算才新鲜），
        // 因此不落盘、不缓存；计算异常时静默回落到原始字段。
        const ecloudDesktops = (client.metrics?.desktops || acc.desktops || []).map(d => {
          let keepAliveView = null;
          try {
            if (typeof client.describeDesktopKeepAlive === 'function') {
              keepAliveView = client.describeDesktopKeepAlive(d);
            }
          } catch (e) { keepAliveView = null; }
          return keepAliveView ? { ...d, keepAliveView } : { ...d };
        });
        return {
          ...acc,
          platform: 'ecloud',
          desktops: ecloudDesktops,
          vms: ecloudDesktops,
          engineState: client.engine ? client.engine.state : 'unknown',
          liveMetrics: client.metrics
        };
      }
      if (acc.platform === 'ydpc') {
        // 【2026-09-23 按主机维度】一个移动云账号下可以挂多台云电脑，各机状态（运行/关机/
        // 时长耗尽/单机保活开关/独立周期/数据面是否在场）可以完全不同 —— 账号级单行文案
        // 表达不了。这里在**序列化时**实时计算每台主机的状态视图（倒计时/是否到期必须
        // 现算才新鲜），因此不落盘、不缓存；计算异常时静默回落到原始 vm 字段。
        const ydpcVms = (client.metrics?.vms || acc.vms || []).map(vm => {
          let keepAliveView = null;
          try {
            if (typeof client.describeVmKeepAlive === 'function') {
              keepAliveView = client.describeVmKeepAlive(vm);
            }
          } catch (e) { keepAliveView = null; }
          return keepAliveView ? { ...vm, keepAliveView } : { ...vm };
        });
        return {
          ...acc,
          platform: 'ydpc',
          vms: ydpcVms,
          desktops: ydpcVms,
          liveMetrics: client.metrics
        };
      }
      const ctyunDesktops = ((client.desktopsCache && client.desktopsCache.length > 0) ? client.desktopsCache : (acc.desktops || [])).map(d => {
        const spec = CtYunClient.extractDesktopSpecs(d, d.flavorName || '公众版');
        return {
          ...d,
          cpu: d.cpu || spec.cpu,
          memory: d.memory || spec.memory,
          specStr: d.specStr || spec.specStr,
          flavorName: d.flavorName || spec.flavorName
        };
      });

      return {
        ...acc,
        platform: 'ctyun',
        desktops: ctyunDesktops,
        pulseIntervalSeconds: parseInt(appConfig.settings?.pulseIntervalSeconds) || 30,
        liveMetrics: client.metrics
      };
    });
    jsonResponse(res, enriched);
    return;
  }

  // 7.4 账号自由拖拽排序持久化 API
  if (req.method === 'POST' && pathname === '/api/accounts/reorder') {
    const session = getSessionFromReq(req);
    if (!session) { jsonResponse(res, { error: '未授权' }, 401); return; }
    const body = await parseJsonBody(req);
    const orderedIds = body.orderedIds;
    if (Array.isArray(orderedIds)) {
      const userAccounts = appConfig.accounts.filter(a => a.ownerId === session.userId);
      const otherAccounts = appConfig.accounts.filter(a => a.ownerId !== session.userId);
      const reordered = [];
      for (const id of orderedIds) {
        const found = userAccounts.find(a => a.id === id);
        if (found) reordered.push(found);
      }
      for (const a of userAccounts) {
        if (!reordered.includes(a)) reordered.push(a);
      }
      appConfig.accounts = [...otherAccounts, ...reordered];
      saveConfig(appConfig);
      jsonResponse(res, { success: true });
      return;
    }
    jsonResponse(res, { error: '参数错误' }, 400);
    return;
  }

  // 7.5 移动云图形验证码获取 API
  if (req.method === 'GET' && pathname === '/api/ydpc/captcha') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请先登录' }, 401);
      return;
    }
    try {
      const soho = new SohoClient({});
      const vcodeData = await soho.getVerificationCode();
      jsonResponse(res, {
        success: true,
        image: vcodeData.image,
        randomCode: vcodeData.randomCode
      });
    } catch (e) {
      jsonResponse(res, { error: e.message || '获取移动云验证码失败' }, 500);
    }
    return;
  }

  // 7.6 移动云测试登录并拉取云电脑列表 API
  if (req.method === 'POST' && pathname === '/api/ydpc/test-login') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请先登录后再操作' }, 401);
      return;
    }
    const body = await parseJsonBody(req);
    const user = (body.user || '').trim();
    const pwd = (body.password || '').trim();
    const accountType = body.accountType || 'main';
    const verificationCode = (body.verificationCode || '').trim();
    const randomCode = (body.randomCode || '').trim();

    if (!user || !pwd) {
      jsonResponse(res, { error: '手机号/账号与密码不能为空' }, 400);
      return;
    }

    try {
      const soho = new SohoClient({ accountType });
      const loginData = await soho.login(user, pwd, accountType, verificationCode, randomCode);
      const vms = await soho.listCloudPcs();
      jsonResponse(res, {
        success: true,
        userId: loginData.userId,
        vmsCount: vms.length,
        vms
      });
    } catch (e) {
      jsonResponse(res, { success: false, error: e.message || '移动云鉴权失败' }, 400);
    }
    return;
  }

  // 7.7 添加移动云电脑账号 API
  if (req.method === 'POST' && pathname === '/api/accounts/ydpc/add') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请先登录或注册账号后再添加云电脑！' }, 401);
      return;
    }

    const currentOwnerId = session.userId;
    const currentUser = authManager.getUserById(currentOwnerId);
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
    const accountType = body.accountType || 'main';
    // 【2026-09-22】移动云账号创建时不显式写入 autoBoot（自动开机守护）：
    // 由账号级 + 单机双开关独立判定，省略即按默认口径（见 ydpc_client.js 的 _autoBootArmed）。
    const keepaliveInterval = parseInt(body.keepaliveInterval) || 600;
    const verificationCode = (body.verificationCode || '').trim();
    const randomCode = (body.randomCode || '').trim();

    if (!user || !pwd) {
      jsonResponse(res, { error: '账号和密码不能为空' }, 400);
      return;
    }

    if (appConfig.accounts.some(a => a.platform === 'ydpc' && a.user === user && a.ownerId === currentOwnerId)) {
      jsonResponse(res, { error: `移动云账号 ${user} 已存在，请勿重复添加！` }, 400);
      return;
    }

    try {
      const soho = new SohoClient({ accountType });
      await soho.login(user, pwd, accountType, verificationCode, randomCode);
      const vms = await soho.listCloudPcs();

      const newAcc = {
        id: 'yd_' + crypto.randomUUID().substring(0, 8),
        platform: 'ydpc',
        ownerId: currentOwnerId,
        name,
        user,
        password: pwd,
        accountType,
        keepaliveInterval,
        enabled: true,
        features: {
          keepAlive: true,
          controlPlaneKeepalive: true,
          mqttKeepAlive: true,
          dataPlaneKeepalive: true
          // autoBoot 走账号级/单机独立判定，省略即按默认口径（见 ydpc_client.js 的 _autoBootArmed）
        },
        vms,
        stats: {
          keepAliveStatus: 'online',
          lastKeepAliveTime: getBeijingTimeString(),
          vmStatus: vms[0]?.vmStatus || '未知',
          durationMode: vms[0]?.durationMode || 'permanent',
          remainHours: vms[0]?.remainHours || 0,
          remainText: vms[0]?.remainText || '♾️ 永久使用'
        },
        createdAt: new Date().toISOString()
      };

      appConfig.accounts.push(newAcc);
      saveConfig(appConfig);

      const client = getClient(newAcc);
      client.startKeepAliveWorker();

      appendLog('SOHO', `[${name}] 移动云账号添加成功，发现 ${vms.length} 台云主机，已自动启动保活守护`, 'success', name, 'ydpc');
      jsonResponse(res, { success: true, account: newAcc }, 201);
    } catch (e) {
      jsonResponse(res, { error: e.message || '移动云认证失败' }, 400);
    }
    return;
  }

  // 7.9 添加移动公众（ecloud）账号
  // ---------------------------------------------------------------
  // 与移动爱家/天翼云的添加流程**各自独立实现**（用户明令：三平台机制不重叠），
  // 也不共用 SOHO 或天翼云的登录客户端 —— 走的是移动公众自己的协议侧车。
  //
  // 移动公众登录可能是多步的（设备信任 / 双因素 / 增强短信），后台无法代答验证码，
  // 因此这里采用「先建临时待定登录、验证码回来后再落库」的两段式：
  //   POST /api/accounts/ecloud/add   → 直接成功则落库；需要短信则返回 pendingId
  //   POST /api/accounts/ecloud/login → 带 pendingId + code 完成并落库
  if (req.method === 'POST' && pathname === '/api/accounts/ecloud/add') {
    const session = getSessionFromReq(req);
    if (!session) { jsonResponse(res, { error: '未授权：请先登录或注册账号后再添加云电脑！' }, 401); return; }

    const currentOwnerId = session.userId;
    const currentUser = authManager.getUserById(currentOwnerId);
    if (currentUser && currentUser.role !== 'admin') {
      const currentOwned = appConfig.accounts.filter(a => a.ownerId === currentOwnerId).length;
      const userMax = currentUser.maxQuota || 2;
      if (currentOwned >= userMax) {
        jsonResponse(res, { error: `已达到云电脑添加配额上限（当前配额: ${userMax}台），无法继续添加！请联系管理员提高配额。` }, 400);
        return;
      }
    }

    const body = await parseJsonBody(req);
    const user = (body.user || '').trim();
    const pwd = (body.password || '').trim();
    const name = (body.name || user).trim();
    const keepaliveInterval = Math.max(60, parseInt(body.keepaliveInterval) || 300);

    if (!user || !pwd) { jsonResponse(res, { error: '移动公众账号与密码不能为空' }, 400); return; }
    if (appConfig.accounts.some(a => a.platform === 'ecloud' && a.user === user && a.ownerId === currentOwnerId)) {
      jsonResponse(res, { error: `移动公众账号 ${user} 已存在，请勿重复添加！` }, 400);
      return;
    }

    const accId = 'ec_' + crypto.randomUUID().substring(0, 8);
    const draftAcc = {
      id: accId,
      platform: 'ecloud',
      ownerId: currentOwnerId,
      name,
      user,
      password: pwd,
      keepaliveInterval,
      enabled: true,
      ecloudDeviceUid: crypto.randomUUID(),
      features: buildEcloudDefaultFeatures(),
      desktops: [],
      stats: { keepAliveStatus: 'offline', lastKeepAliveTime: '' },
      createdAt: new Date().toISOString()
    };

    try {
      const draftClient = new EcloudClient(draftAcc, {
        appendLog,
        sendNotification: sendAccountNotification,
        saveConfig: () => saveConfig(appConfig),
        resolveTaskEnabled: (account, desktop, taskType) => resolveTaskEnabled(account, desktop, taskType)
      });
      const r = await draftClient.loginInteractive(null, '');
      const status = r && r.status;

      if (status === 'success') {
        const desktops = await draftClient.refreshDesktops().catch(() => []);
        finalizeEcloudAccount(draftAcc, draftClient);
        appendLog(ECLOUD_LOG_SOURCE, `[${name}] 移动公众账号添加成功，发现 ${desktops.length} 台云电脑，已启动独立保活守护`, 'success', name, 'ecloud');
        jsonResponse(res, { success: true, account: draftAcc, desktops }, 201);
        return;
      }

      if (INTERACTIVE_BRANCHES.has(status)) {
        // 需要短信验证码：保留这次会话（含侧车内的登录中间态），等验证码回来再落库。
        draftClient.account = draftAcc;
        const mobile = (r && r.mobile) || '';
        registerPendingEcloudLogin(accId, { acc: draftAcc, client: draftClient, branch: status, mobile });
        appendLog(ECLOUD_LOG_SOURCE, `[${name}] 移动公众登录需要短信验证（分支 ${status}），正在下发验证码…`, 'warning', name, 'ecloud');

        // ⚠️ 必须真正发码：服务端**不会**因为密码登录要求二次验证就替我们发短信，
        // 官方客户端是在拿到 mobile 后自己再打一次发码接口。这里绝不"假定已发送"——
        // 发送结果如实回给前端，失败也要把原因说清楚（否则就是"界面让你输码但手机收不到"）。
        let smsSent = false;
        let smsError = '';
        try {
          await draftClient.loginSendSms(status, mobile);
          smsSent = true;
          appendLog(ECLOUD_LOG_SOURCE, `[${name}] 验证码已下发，等待用户输入（分支 ${status}）`, 'info', name, 'ecloud');
        } catch (smsErr) {
          smsError = smsErr.message || String(smsErr);
          appendLog(ECLOUD_LOG_SOURCE, `[${name}] 短信验证码下发失败: ${smsError}`, 'error', name, 'ecloud');
        }

        jsonResponse(res, {
          needVerification: true,
          pendingId: accId,
          branch: status,
          mobile,
          smsSent,
          smsError,
          message: smsSent
            ? '已下发短信验证码，请输入收到的验证码完成绑定。'
            : '账号需要短信验证，但验证码下发失败，请点击「重新发送验证码」重试。'
        }, 202);
        return;
      }

      // locked / failed
      jsonResponse(res, { error: (r && r.error) || `移动公众登录未成功（${status || '未知'}）` }, 400);
    } catch (e) {
      appendLog(ECLOUD_LOG_SOURCE, `[${name}] 添加移动公众账号失败: ${e.message}`, 'error', name, 'ecloud');
      jsonResponse(res, { error: e.message || '移动公众认证失败' }, 400);
    }
    return;
  }

  // 7.10 完成移动公众的短信验证并落库
  if (req.method === 'POST' && pathname === '/api/accounts/ecloud/login') {
    const session = getSessionFromReq(req);
    if (!session) { jsonResponse(res, { error: '未授权' }, 401); return; }

    const body = await parseJsonBody(req);
    const pendingId = (body.pendingId || '').trim();
    const code = (body.code || '').trim();
    const entry = pendingEcloudLogins.get(pendingId);
    if (!entry) { jsonResponse(res, { error: '待定登录已过期或不存在，请重新添加账号' }, 400); return; }
    if (entry.acc.ownerId !== session.userId) { jsonResponse(res, { error: '权限不足：无权操作该账号' }, 403); return; }

    try {
      const r = await entry.client.loginInteractive(entry.branch, code, {
        mobile: body.mobile || entry.mobile,
        isTemporary: !!body.isTemporary
      });
      if (r && r.status === 'success') {
        pendingEcloudLogins.delete(pendingId);
        const desktops = await entry.client.refreshDesktops().catch(() => []);
        finalizeEcloudAccount(entry.acc, entry.client);
        appendLog(ECLOUD_LOG_SOURCE, `[${entry.acc.name}] 短信验证通过，移动公众账号添加成功（${desktops.length} 台云电脑）`, 'success', entry.acc.name, 'ecloud');
        jsonResponse(res, { success: true, account: entry.acc, desktops }, 201);
        return;
      }
      jsonResponse(res, { error: (r && r.error) || `验证未通过（${r && r.status}）` }, 400);
    } catch (e) {
      jsonResponse(res, { error: e.message || '短信验证失败' }, 400);
    }
    return;
  }

  // 7.10b 重新下发移动公众短信验证码
  //   验证码过期/未收到时的**唯一出路**：若让用户"删号重加"，会再走一次密码登录，
  //   而交互登录有 10 分钟 / 3 次限流（login_rate_limit），很容易把自己锁在门外。
  if (req.method === 'POST' && pathname === '/api/accounts/ecloud/resend') {
    const session = getSessionFromReq(req);
    if (!session) { jsonResponse(res, { error: '未授权' }, 401); return; }

    const body = await parseJsonBody(req);
    const pendingId = (body.pendingId || '').trim();
    const entry = pendingEcloudLogins.get(pendingId);
    if (!entry) { jsonResponse(res, { error: '待定登录已过期或不存在，请重新添加账号' }, 400); return; }
    if (entry.acc.ownerId !== session.userId) { jsonResponse(res, { error: '权限不足：无权操作该账号' }, 403); return; }

    const mobile = (body.mobile || entry.mobile || '').trim();
    try {
      await entry.client.loginSendSms(entry.branch, mobile);
      if (mobile) entry.mobile = mobile;
      jsonResponse(res, { success: true, mobile: entry.mobile || '', branch: entry.branch });
    } catch (e) {
      appendLog(ECLOUD_LOG_SOURCE, `[${entry.acc.name}] 重新下发验证码失败: ${e.message}`, 'error', entry.acc.name, 'ecloud');
      jsonResponse(res, { error: e.message || '验证码下发失败' }, 400);
    }
    return;
  }

  // 7.11 手动触发一次移动公众保活（与自动巡检走同一条代码路径，便于排障）
  if (req.method === 'POST' && pathname === '/api/accounts/ecloud/keepalive') {
    const session = getSessionFromReq(req);
    if (!session) { jsonResponse(res, { error: '未授权' }, 401); return; }
    const body = await parseJsonBody(req).catch(() => ({}));
    const acc = appConfig.accounts.find(a => a.id === body.accountId && a.platform === 'ecloud');
    if (!acc) { jsonResponse(res, { error: '未找到该移动公众账号' }, 404); return; }
    if (!canUserAccessAccount(session, acc)) { jsonResponse(res, { error: '权限不足：无权操作该账号' }, 403); return; }
    const client = getClient(acc);
    try {
      const out = await client.runKeepAliveOnce();
      jsonResponse(res, { success: true, result: out, liveMetrics: client.metrics });
    } catch (e) {
      jsonResponse(res, { error: e.message || '移动公众保活执行失败' }, 400);
    }
    return;
  }

  // 8. 添加天翼云账号（包含：必须登录 + 强配额限制 + 真实登录校验）
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

    const captchaCode = (body.captchaCode || '').trim();
    const challengeId = (body.challengeId || '').trim();
    const challengeCode = (body.challengeCode || '').trim();

    if (!user || !pwd) {
      jsonResponse(res, { error: '账号和密码不能为空' }, 400);
      return;
    }

    if (!captchaCode || !challengeId || !challengeCode) {
      jsonResponse(res, { error: '图形验证码已失效或未填写，请刷新验证码后重试！' }, 400);
      return;
    }

    appendLog('Auth', `正在严格校验天翼云账号密码真实性: ${user} ...`, 'info');

    const tempAccount = { user, password: pwd, deviceCode: devCode, platform: 'ctyun' };
    const tempClient = new CtYunClient(tempAccount);
    const logRes = await tempClient.loginWithCaptcha(captchaCode, challengeId, challengeCode);

    if (!logRes.success) {
      appendLog('Auth', `[${name}] 登录校验被拒绝: ${logRes.error}`, 'error');
      jsonResponse(res, { error: logRes.error || '验证码或账号密码错误，请检查！' }, 400);
      return;
    }

    const loginData = logRes.data;
    const isBound = !!loginData.bondedDevice;
    appendLog('Auth', `[${name}] 🎉 真实登录校验通过！用户ID: ${loginData.userId}，设备绑定: ${isBound ? '已就绪' : '待短信验证'}`, 'success');

    const id = crypto.randomUUID().substring(0, 8);
    const newAcc = {
      id,
      platform: 'ctyun',
      ownerId: currentOwnerId,
      name,
      user,
      password: pwd,
      deviceCode: devCode,
      savedLoginInfo: loginData,
      displayConfig: {
        width: 2560,
        height: 1440,
        scale: 150
      },
      enabled: true,
      bound: isBound,
      sessionExpired: false,
      features: {
        keepAlive: true,
        autoSign: true,
        aiChat: true,
        cloudHang: false,
        autoRedeem: false,
        // 2026-09-28：移动云自动开机守护默认开启（用户拍板）；关闭请显式关开关。
        autoBoot: true
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

  // 8.8 单台云电脑独立特性开关切换 API (支持移动云 VM 与天翼云 Desktop 独立保活与开机控制)
  if (req.method === 'PUT' && pathname.match(/^\/api\/accounts\/([^\/]+)\/vm-feature$/)) {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }
    const match = pathname.match(/^\/api\/accounts\/([^\/]+)\/vm-feature$/);
    const accId = match[1];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc) {
      jsonResponse(res, { error: '账号不存在' }, 404);
      return;
    }

    if (session.role !== 'admin' && acc.ownerId !== session.userId) {
      jsonResponse(res, { error: '权限不足：无法操作属于其他用户的云电脑' }, 403);
      return;
    }

    const body = await parseJsonBody(req);
    const vmKey = String(body.vmId || body.desktopId || body.userServiceId || '');
    const featureName = body.feature; // 'keepaliveEnabled' | 'autoBootEnabled' | 'taskEnabled' | 'keepaliveInterval'
    // （数据面保活是账号级 features.dataPlaneKeepalive，在「自动化保活开关」区，不走单机 toggle）

    if (!vmKey || !['keepaliveEnabled', 'autoBootEnabled', 'taskEnabled', 'keepaliveInterval'].includes(featureName)) {
      jsonResponse(res, { error: '参数错误：必须提供有效的 vmId 与 feature' }, 400);
      return;
    }

    // 【2026-09-23 修订】移动云【自动开机守护】开关已恢复放行。
    // 开机能力改走 CAG HTTPS 干净通道（app/ydpc/cag_boot.js）：账号自有 firm-auth 凭据、
    // RSA 公钥动态获取、保留 TLS 证书校验，不伪造客户端身份。
    // 伪造身份 / 硬编码第三方凭据 / 关证书 等红线仍由回归组 7 机械拦截。

    let finalValue = body.value;
    if (featureName === 'keepaliveInterval') {
      const num = parseInt(body.value);
      finalValue = (!isNaN(num) && num > 0) ? num : null;
    } else {
      finalValue = body.value !== false;
    }

    let updatedTarget = null;
    if (acc.platform === 'ydpc') {
      acc.vms = acc.vms || [];
      const targetVm = acc.vms.find(v => String(v.userServiceId) === vmKey);
      if (targetVm) {
        targetVm[featureName] = finalValue;
        updatedTarget = targetVm;
      }
    } else if (acc.platform === 'ecloud') {
      // 移动公众的每台云电脑以 instanceId 为主键（与 ydpc 的 userServiceId 各自独立）
      acc.desktops = acc.desktops || [];
      const targetDesktop = acc.desktops.find(d => String(d.instanceId) === vmKey);
      if (targetDesktop) {
        targetDesktop[featureName] = finalValue;
        updatedTarget = targetDesktop;
      }
    } else {
      acc.desktops = acc.desktops || [];
      const targetDesktop = acc.desktops.find(d => String(d.desktopId || d.objId) === vmKey);
      if (targetDesktop) {
        targetDesktop[featureName] = finalValue;
        updatedTarget = targetDesktop;
      }
    }

    saveConfig(appConfig);
    const client = getClient(acc);
    if (acc.platform === 'ydpc' && client && client.account) {
      client.account.vms = acc.vms;
    } else if (acc.platform === 'ecloud' && client && client.account) {
      client.account.desktops = acc.desktops;
    } else if (client && client.account) {
      client.account.desktops = acc.desktops;
    }

    // 若当前正在执行该主机的挂机任务且用户关闭了任务开关，立即安全释放当前长连接
    if (featureName === 'taskEnabled' && finalValue === false && client && client.isTaskHanging) {
      if (String(client.metrics?.desktopId) === String(vmKey)) {
        if (client.endCurrentSession) {
          client.endCurrentSession('User Disabled Task on Active Desktop');
        }
      }
    }

    let featureCn = '单机属性';
    if (featureName === 'keepaliveEnabled') featureCn = '独立保活';
    else if (featureName === 'taskEnabled') featureCn = '自动化任务';
    else if (featureName === 'autoBootEnabled') featureCn = '自动开机';
    else if (featureName === 'keepaliveInterval') featureCn = `独立保活周期 (${finalValue ? Math.round(finalValue/60) + '分钟' : '继承账号默认'})`;

    appendLog('System', `[${acc.name}] 已将云主机 [${vmKey}] 的【${featureCn}】更新为: ${finalValue ? (typeof finalValue === 'boolean' ? '开启' : finalValue + '秒') : '关闭/继承'}`, 'info');
    jsonResponse(res, { success: true, target: updatedTarget, account: acc });
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
    if (body.accountType) acc.accountType = body.accountType;
    if (body.keepaliveInterval) acc.keepaliveInterval = body.keepaliveInterval;
    if (body.deviceCode) acc.deviceCode = body.deviceCode;
    if (body.displayConfig) acc.displayConfig = { ...acc.displayConfig, ...body.displayConfig };
    if (typeof body.enabled === 'boolean') acc.enabled = body.enabled;
    if (typeof body.bound === 'boolean') acc.bound = body.bound;
    if (body.features) acc.features = { ...acc.features, ...body.features };
    if (body.redeemConfig) acc.redeemConfig = { ...acc.redeemConfig, ...body.redeemConfig };
    if (body.stats) acc.stats = { ...acc.stats, ...body.stats };

    // 移动云电脑：重新同步云主机列表与时长状态
    if (acc.platform === 'ydpc') {
      const client = getClient(acc);
      if (body.accountType) client.sohoClient.accountType = body.accountType;
      await client.refreshVms().catch(() => {});
    }

    // 移动公众：重新同步桌面列表（会话失效时会尝试恢复/重登，需短信验证时如实上报）
    if (acc.platform === 'ecloud') {
      const client = getClient(acc);
      await client.refreshDesktops().catch(() => {});
    }

    // 用户在界面上明确手动开启了保活开关：解除 manualShutdown 关机阻断
    if (body.features && body.features.keepAlive === true) {
      acc.manualShutdown = false;
    }

    // 支持输入验证码重新激活登录
    if (body.captchaCode && body.challengeId && body.challengeCode) {
      appendLog('Auth', `[${acc.name}] 正在提交用户输入的验证码重新校验天翼云登录态...`, 'info');
      const client = getClient(acc);
      const logRes = await client.loginWithCaptcha(body.captchaCode, body.challengeId, body.challengeCode);
      if (!logRes.success) {
        jsonResponse(res, { error: logRes.error || '验证码或密码校验失败' }, 400);
        return;
      }
      acc.bound = !!logRes.data.bondedDevice;
      acc.sessionExpired = false;
      appendLog('Auth', `[${acc.name}] 🎉 重新验证登录成功，凭证已刷新！`, 'success');
      // 立即同步官方任务中心与积分，确保前端看板即时呈现
      await client.refreshOfficialTasks();
    }

    saveConfig(appConfig);
    appendLog('System', `已更新账号配置: ${acc.name}`, 'info');

    const client = getClient(acc);

    // 如果用户关闭了挂机开关，若当前正处于挂机长连接会话中，立即主动断开并转入脉冲休眠
    if (body.features && body.features.cloudHang === false) {
      if (client.endCurrentSession) {
        client.endCurrentSession('User Disabled Hang Mode');
      }
      if (client.clearHangRetry) {
        client.clearHangRetry();
      }
    }

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

  // 10.5 代理获取天翼云官方图形验证码与挑战数据 (人工输码模式)
  if (req.method === 'GET' && pathname.startsWith('/api/captcha/')) {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }

    const phone = pathname.split('/')[3] || '';
    const deviceCode = (parsedUrl.searchParams.get('deviceCode') || '').trim() || generateDeviceCode();

    try {
      // 1. 获取 Challenge Code
      const chalRes = await fetch('https://desk.ctyun.cn:8810/api/auth/client/genChallengeData', {
        method: 'POST',
        headers: {
          'ctg-devicetype': '60',
          'ctg-version': '103020001',
          'ctg-devicecode': deviceCode,
          'Content-Type': 'application/json'
        },
        body: '{}'
      });
      const chalData = await chalRes.json();
      if (chalData.code !== 0) throw new Error(chalData.msg || '获取验证码挑战失败');

      const { challengeCode, challengeId } = chalData.data;

      // 2. 拉取官方图形验证码图片流并转为 Base64
      const capUrl = `https://desk.ctyun.cn:8810/api/auth/client/captcha?height=36&width=85&userInfo=${encodeURIComponent(phone)}&mode=auto&_t=${Date.now()}`;
      const capRes = await fetch(capUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0',
          'ctg-devicetype': '60',
          'ctg-version': '103020001',
          'ctg-devicecode': deviceCode,
          'referer': 'https://pc.ctyun.cn/'
        }
      });
      const imgBuf = Buffer.from(await capRes.arrayBuffer());
      const base64Img = `data:image/jpeg;base64,${imgBuf.toString('base64')}`;

      jsonResponse(res, {
        success: true,
        challengeCode,
        challengeId,
        deviceCode,
        captchaImage: base64Img
      });
    } catch (e) {
      jsonResponse(res, { error: e.message }, 500);
    }
    return;
  }

  // 10.6 生成天翼云官方 App 扫码登录二维码 API
  if (req.method === 'POST' && pathname === '/api/account/qrcode/generate') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请先登录后再操作' }, 401);
      return;
    }

    const devCode = generateDeviceCode();
    const tempClient = new CtYunClient({ deviceCode: devCode, user: 'qrcode_temp' });
    try {
      const qrData = await tempClient.genQrCode();
      jsonResponse(res, {
        success: true,
        deviceCode: devCode,
        qrCodeId: qrData.qrCodeId,
        qrUrl: qrData.qrUrl
      });
    } catch (e) {
      jsonResponse(res, { error: e.message || '生成官方二维码失败' }, 500);
    }
    return;
  }

  // 10.7 轮询天翼云官方 App 扫码状态 API
  if (req.method === 'GET' && pathname === '/api/account/qrcode/status') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请先登录后再操作' }, 401);
      return;
    }

    const qrCodeId = parsedUrl.searchParams.get('qrCodeId');
    const deviceCode = parsedUrl.searchParams.get('deviceCode') || generateDeviceCode();
    const accountName = (parsedUrl.searchParams.get('accountName') || '').trim();
    const targetAccId = parsedUrl.searchParams.get('accId');

    if (!qrCodeId) {
      jsonResponse(res, { error: '缺少 qrCodeId 参数' }, 400);
      return;
    }

    const tempClient = new CtYunClient({ deviceCode, user: 'qrcode_temp' });
    try {
      const statusRes = await tempClient.getQrCodeStatus(qrCodeId);
      if (statusRes.codeStatus === 'authorize' && statusRes.loginToken) {
        appendLog('Auth', `[扫码登录] 手机端已授权确认，正在换取正式登录凭据...`, 'info');
        const loginData = await tempClient.loginByToken(statusRes.loginToken);
        const userPhone = loginData.mobilephone || loginData.userName || '已扫码账号';
        const finalName = accountName || `天翼账号_${userPhone.slice(-4)}`;
        const currentOwnerId = session.userId;

        // 检查是否为已有账号重新扫码授权 (通过 accId 指定或同用户同手机号)
        let existingAcc = null;
        if (targetAccId) {
          existingAcc = appConfig.accounts.find(a => a.id === targetAccId && a.ownerId === currentOwnerId);
        }
        if (!existingAcc) {
          existingAcc = appConfig.accounts.find(a => (a.user === userPhone || a.user === userPhone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2')) && a.ownerId === currentOwnerId && a.platform !== 'ydpc');
        }

        if (existingAcc) {
          existingAcc.user = userPhone;
          existingAcc.deviceCode = deviceCode;
          existingAcc.savedLoginInfo = loginData;
          existingAcc.sessionExpired = false;
          existingAcc.bound = true;
          if (accountName) existingAcc.name = accountName;
          saveConfig(appConfig);

          const client = getClient(existingAcc);
          client.loginInfo = loginData;
          client.account.sessionExpired = false;
          client.startKeepAliveWorker();

          appendLog('Auth', `[${existingAcc.name}] 🎉 官方扫码重新授权成功！已恢复在线保活。`, 'success', existingAcc.name, 'ctyun');
          jsonResponse(res, {
            success: true,
            codeStatus: 'authorize',
            account: existingAcc,
            isReAuth: true
          });
          return;
        }

        // 新建账号前检查普通用户配额
        const currentUser = authManager.getUserById(currentOwnerId);
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

        const id = 'ct_' + crypto.randomUUID().substring(0, 8);
        const newAcc = {
          id,
          platform: 'ctyun',
          ownerId: currentOwnerId,
          name: finalName,
          user: userPhone,
          password: '',
          deviceCode,
          savedLoginInfo: loginData,
          displayConfig: { width: 2560, height: 1440, scale: 150 },
          enabled: true,
          bound: true,
          sessionExpired: false,
          features: {
            keepAlive: true,
            autoSign: true,
            aiChat: true,
            cloudHang: false,
            autoRedeem: false,
            // 2026-09-28：移动云自动开机守护默认开启（用户拍板）
            autoBoot: true
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

        appendLog('Auth', `[${finalName}] 🎉 官方扫码授权成功！已绑定并上线保活。`, 'success');
        jsonResponse(res, {
          success: true,
          codeStatus: 'authorize',
          account: newAcc
        });
        return;
      }

      jsonResponse(res, {
        success: true,
        codeStatus: statusRes.codeStatus
      });
    } catch (e) {
      jsonResponse(res, { error: e.message }, 500);
    }
    return;
  }

  // 11. 生成设备码
  if (req.method === 'POST' && pathname === '/api/device/generate') {
    jsonResponse(res, { deviceCode: generateDeviceCode() });
    return;
  }

  // 12.1 获取设备绑定短信流程的图形验证码 (严格对齐官方 /api/auth/client/validateCode/captcha 链路)
  if (req.method === 'GET' && pathname.match(/^\/api\/accounts\/[^\/]+\/sms-captcha$/)) {
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
      const timestamp = Date.now();
      const capUrl = `https://desk.ctyun.cn:8810/api/auth/client/validateCode/captcha?width=120&height=40&_t=${timestamp}`;
      const capRes = await fetch(capUrl, { headers: client.getSignedHeaders() });
      if (!capRes.ok) throw new Error(`获取短信图验失败: HTTP ${capRes.status}`);
      const captchaKey = capRes.headers.get('ctg-captcha-key') || capRes.headers.get('CTG-CAPTCHA-KEY') || '';
      const imgBuf = Buffer.from(await capRes.arrayBuffer());
      const base64Img = `data:image/jpeg;base64,${imgBuf.toString('base64')}`;
      jsonResponse(res, { success: true, captchaImage: base64Img, captchaKey });
    } catch (e) {
      jsonResponse(res, { error: e.message }, 500);
    }
    return;
  }

  // 12. 发送短信验证码 (需先通过官方图形验证码校验，并透传 ctg-sms-key)
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

    const body = await parseJsonBody(req);
    const captchaCode = (body.captchaCode || '').trim();
    const captchaCodeKey = (body.captchaKey || '').trim();
    if (!captchaCode) {
      jsonResponse(res, { error: '请先输入图形验证码后再获取短信验证码！' }, 400);
      return;
    }

    const client = getClient(acc);
    try {
      appendLog('Auth', `[${acc.name}] 正在请求天翼云下发设备绑定验证码...`, 'info');
      let url = `https://desk.ctyun.cn:8810/api/cdserv/client/device/getSmsCode?mobilePhone=${acc.user}&captchaCode=${encodeURIComponent(captchaCode)}`;
      if (captchaCodeKey) {
        url += `&captchaCodeKey=${encodeURIComponent(captchaCodeKey)}`;
      }
      const resSms = await fetch(url, { headers: client.getSignedHeaders() });
      const dataSms = await resSms.json();
      const smsKey = resSms.headers.get('ctg-sms-key') || resSms.headers.get('CTG-SMS-KEY') || '';
      if (dataSms.code === 0 || dataSms.code === 200) {
        if (smsKey) {
          acc._smsCodeKey = smsKey;
          saveConfig(appConfig);
        }
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
      const smsCodeKey = (body.smsCodeKey || acc._smsCodeKey || '').trim();
      const form = new URLSearchParams({
        verificationCode: code,
        deviceName: 'Chrome浏览器',
        deviceCode: acc.deviceCode || '',
        deviceModel: 'Windows NT 10.0; Win64; x64',
        sysVersion: 'Windows NT 10.0; Win64; x64',
        appVersion: '3.2.0',
        hostName: 'pc.ctyun.cn',
        deviceInfo: 'Win32'
      });
      if (smsCodeKey) {
        form.append('smsCodeKey', smsCodeKey);
      }
      const bindRes = await fetch('https://desk.ctyun.cn:8810/api/cdserv/client/device/binding', {
        method: 'POST',
        headers: { ...client.getSignedHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString()
      });
      const bindData = await bindRes.json();
      if (bindData.code === 0 || bindData.code === 200) {
        acc.bound = true;
        delete acc._smsCodeKey;
        // 同步会话态：官方已信任本设备，免密凭据 (genLoginToken/tokenLogin) 与静默续期自此恢复可用
        if (client.loginInfo) {
          client.loginInfo.bondedDevice = true;
        }
        saveConfig(appConfig);
        appendLog('Auth', `[${acc.name}] 恭喜！新设备验证通过，设备码永久信任！每日签到与静默续期已全面恢复。`, 'success');
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

    try {
      if (taskType === 'sign') {
        executeNativeSign(client, acc, (src, msg, lvl) => appendLog(src, `[${acc.name}] ${msg}`, lvl))
          .then(async (signRes) => {
            // 只有官方任务中心确认达成，才更新完成时间并推送成功通知，绝不虚报
            if (signRes && signRes.isCompleted) {
              await client.refreshOfficialTasks();
              saveConfig(appConfig);
              sendAccountNotification(
                acc,
                `✅ 登录打卡达成 - ${acc.name}`,
                `账号【${acc.name}】今日登录AI云电脑任务已完成，100 积分已到账！`
              );
            } else if (signRes && signRes.pendingVerify) {
              appendLog('Sign', `[${acc.name}] 打卡认领已下发，官方尚未确认。已安排跨分钟复检 (期间不会重复认领，不会打扰客户端)。`, 'info');
            }
          })
          .catch(err => appendLog('Sign', `[${acc.name}] 打卡执行异常: ${err.message}`, 'error'));

        // 中性返回：认领下发 ≠ 任务达成。原先此处直接回"指令已下发"并被前端渲染为成功，
        // 是历史上"页面显示成功、实际没有积分"的直接来源。
        jsonResponse(res, { message: `[${acc.name}] 打卡流程已启动：认领后需等待官方任务中心确认，系统会自动复检。请稍后刷新查看结果。` });
        return;

      } else if (taskType === 'aiChat') {
        executeNativeAiChat(client, acc, (src, msg, lvl) => appendLog(src, `[${acc.name}] ${msg}`, lvl))
          .then(async () => {
            const r = await client.refreshOfficialTasks();
            const t = (client.metrics.officialTasks || []).find(x => x.name.includes('AI对话'));
            const done = !!(t && (t.status === 2 || (t.total > 0 && t.current >= t.total)));
            if (done) {
              saveConfig(appConfig);
              sendAccountNotification(
                acc,
                `🤖 AI对话任务达成 - ${acc.name}`,
                `账号【${acc.name}】今日AI智能对话任务已完成，100 积分已入账！`
              );
            } else if (r && r.ok === false) {
              appendLog('AIChat', `[${acc.name}] ⚠️ AI 对话请求已发出，但官方任务中心不可读 (${r.reason})，无法核对是否计入。请稍后手动刷新确认。`, 'warning');
            } else {
              appendLog('AIChat', `[${acc.name}] ⚠️ AI 对话请求已发出，但官方任务中心暂未显示达成 (落账可能有延迟)。本次不判定为完成。`, 'warning');
            }
          })
          .catch(err => appendLog('AIChat', `[${acc.name}] AI 对话任务异常: ${err.message}`, 'error'));

        jsonResponse(res, { message: `[${acc.name}] AI 对话已启动，结果以官方任务中心为准，请稍后刷新查看。` });
        return;

      } else if (taskType === 'hang') {
        executeNativeHang(client, acc, (src, msg, lvl) => appendLog(src, `[${acc.name}] ${msg}`, lvl))
          .then(async () => {
            const r = await client.refreshOfficialTasks();
            const t = (client.metrics.officialTasks || []).find(x => x.name.includes('使用1小时'));
            const done = !!(t && (t.status === 2 || (t.total > 0 && t.current >= t.total)));
            const curMin = t ? Math.floor((t.current || 0) / 60) : 0;
            if (done) {
              saveConfig(appConfig);
              appendLog('Hang', `[${acc.name}] ✅ 官方任务中心已确认今日挂机 1 小时达成。`, 'success');
              sendAccountNotification(
                acc,
                `🎉 挂机1小时任务达成 - ${acc.name}`,
                `账号【${acc.name}】今日使用 AI 云电脑达到 1 小时任务已完成，100 积分已入账！`
              );
            } else if (r && r.ok === false) {
              appendLog('Hang', `[${acc.name}] ⚠️ 官方任务中心不可读 (${r.reason})，无法核对挂机进度。本次不判定。`, 'warning');
            } else {
              // 原先此处无条件写入 lastHangTime，导致数据模型虚报"今日已执行挂机"
              appendLog('Hang', `[${acc.name}] 本次挂机阶段结束，官方进度 ${curMin}/60 分钟，尚未达成。已按其自愈机制安排续跑。`, 'info');
            }
          })
          .catch(err => appendLog('Hang', `[${acc.name}] 挂机守护异常: ${err.message}`, 'error'));

        jsonResponse(res, { message: `[${acc.name}] 挂机守护已启动，进度以官方任务中心为准，请稍后刷新查看。` });
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
        prodInstId: d.prodInstId || '',
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
      const requestedDesktopId = parsedUrl.searchParams.get('desktopId');
      let desktop = desktops[0];
      if (requestedDesktopId) {
        const matched = desktops.find(d => String(d.objId || d.desktopId) === String(requestedDesktopId));
        if (matched) desktop = matched;
      }
      const objId = desktop.objId || desktop.desktopId;
      const b64Id = Buffer.from(String(objId)).toString('base64');
      const targetUrl = `https://pc.ctyun.cn/#/desktop?id=${encodeURIComponent(b64Id)}`;

      const displayCfg = acc.displayConfig || { width: 2560, height: 1440, scale: 150 };
      const sessionToken = getSessionFromReq(req)?.token || (parsedUrl.searchParams.get('token') || '');

      // 直通操作页面入口 URL (带授权 Token 和云电脑 ID)
      const directViewUrl = `/desktop-view?accId=${accId}&token=${encodeURIComponent(sessionToken || '')}&desktopId=${encodeURIComponent(objId)}`;

      // 构造免密直达认证包 (localStorage.authData + web_device_code + authExpiredAt)
      const authDataObj = {
        ...client.loginInfo,
        logined: true,
        userId: client.loginInfo?.userId,
        userName: client.loginInfo?.userName,
        userEid: client.loginInfo?.userEid || '',
        userAccount: client.loginInfo?.userAccount || '',
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
    const times = Math.max(1, parseInt(body.times) || 1);

    if (!prodId || costPoints <= 0) {
      jsonResponse(res, { error: '商品参数无效' }, 400);
      return;
    }

    const client = getClient(acc);
    try {
      // 下单前零预热：直接使用内存缓存数据，杜绝下单前一刻的连环查询触发风控请求指纹
      const cachedPts = client.metrics.userPoints || acc.stats?.points || 0;
      const totalCost = costPoints * times;
      if (cachedPts > 0 && cachedPts < totalCost) {
        jsonResponse(res, { error: `积分不足：当前拥有 ${cachedPts} 积分，本次兑换需要 ${totalCost} 积分！` }, 400);
        return;
      }

      // 目标云电脑判定
      const needsDesktop = rewardNeedsDesktop(prodId, prodType);
      const targetDesktopId = parseInt(body.desktopId) || parseInt(client.metrics.desktopId) || parseInt(acc.stats?.desktopId) || 0;
      if (needsDesktop && !targetDesktopId) {
        jsonResponse(res, { error: '该商品（升配/数据盘扩容）必须选择绑定的目标云电脑！' }, 400);
        return;
      }

      appendLog('Redeem', `[${acc.name}] 正在向天翼云发起真实下单: ${prodName} x${times}，总计 ${totalCost} 积分 (商品类型: ${prodType})...`, 'info');

      const placeOrderUrl = 'https://desk.ctyun.cn/selforder/api/selforder/paas/placeOrder';
      let success = false;
      let lastError = '';
      let isRisk = false;

      // 报文属性构建
      const orderAttrs = [];
      if (needsDesktop) {
        orderAttrs.push({ attrKey: 'bindDesktopId', attrVal: Number(targetDesktopId) });
      } else {
        orderAttrs.push({ attrKey: 'mobilephone' });
      }

      // 原子总积分下单：单笔请求直传总积分 points = costPoints * times
      // 天翼云 PaaS 将在云端一次性合并处理，直接生成 xN 扩容工单，彻底规避连续发单导致的扩容中锁定冲突！
      const orderPayload = {
        busiChannel: '010',
        orderType: 1,
        pointType: Number(body.pointType) || 1,
        points: Number(totalCost),
        sku: [{
          execSort: 1,
          prodId: Number(prodId),
          prodType,
          attrs: orderAttrs
        }]
      };

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          if (attempt > 1) {
            appendLog('Redeem', `[${acc.name}] 正在进行第 ${attempt}/3 次自动重试...`, 'info');
            await new Promise(r => setTimeout(r, 3000));
          }

          const orderRes = await fetch(placeOrderUrl, {
            method: 'POST',
            headers: client.getSignedHeaders({ 'Content-Type': 'application/json;charset=UTF-8' }),
            body: JSON.stringify(orderPayload)
          });
          const orderData = await orderRes.json();

          if (orderData.code === 0) {
            success = true;
            appendLog('Redeem', `[${acc.name}] ✅ 成功一次性完成【${prodName}】x${times} 兑换，共扣除 ${totalCost} 积分！`, 'success');
            break;
          }

          lastError = orderData.msg || `错误码 ${orderData.code}`;
          
          const isFatal = 
            lastError.includes('积分不足') || 
            lastError.includes('点数不足') || 
            lastError.includes('余额不足') ||
            lastError.includes('风控') || 
            lastError.includes('频繁') || 
            lastError.includes('异常操作') ||
            lastError.includes('超过最大') ||
            lastError.includes('上限');

          if (isFatal) {
            if (lastError.includes('风控') || lastError.includes('频繁') || lastError.includes('异常操作')) {
              isRisk = true;
            }
            appendLog('Redeem', `[${acc.name}] 下单触发限制 (${lastError})，终止重试。`, 'warning');
            break;
          }

          appendLog('Redeem', `[${acc.name}] 第 ${attempt} 次下单未成功: ${lastError}`, 'warning');
        } catch (e) {
          lastError = e.message;
          appendLog('Redeem', `[${acc.name}] 第 ${attempt} 次网络异常: ${lastError}`, 'warning');
        }
      }

      if (success) {
        sendAccountNotification(
          acc,
          `🎉 天翼云积分兑换成功 - ${acc.name}`,
          `账号 [${acc.name}] 成功兑换 [${prodName}] x${times}，共扣除 ${totalCost} 积分。`
        );
      }

      // 下单动作已全部结束，此时再同步官方积分与任务状态（安全窗口）
      await client.refreshOfficialTasks();

      if (success) {
        jsonResponse(res, { success: true, message: `🎉 兑换成功！已成功兑换 ${prodName} x${times}，共消耗 ${totalCost} 积分，剩余 ${client.metrics.userPoints || 0} 积分` });
      } else {
        let errorReason = '';
        const msg = lastError || '';
        if (isRisk || msg.includes('风控')) {
          errorReason = '【触发天翼云反欺诈风控】已被临时拦截，已自动停止重试防止加重。请使用官方手机 App 正常操作一次（或短信验证）即可自动解除！';
        } else if (msg.includes('unknow instType') || msg.includes('add subsku')) {
          errorReason = '【商品属性不匹配】该商品为独立发放型商品，无法作为云电脑子配置绑定。';
        } else if (msg.includes('目标资源不存在')) {
          errorReason = '【目标资源不存在】未找到有效绑定的云电脑，请确认设备在线后再试。';
        }
        appendLog('Redeem', `[${acc.name}] 兑换失败: ${msg}${errorReason ? ' -> ' + errorReason : ''}`, 'error');
        jsonResponse(res, {
          error: `兑换失败: ${msg || '未成功'}`,
          reason: errorReason || '天翼云服务接口返回异常',
          rawMsg: msg
        }, 400);
      }
    } catch (e) {
      jsonResponse(res, { error: `下单请求异常: ${e.message}` }, 500);
    }
    return;
  }

  // 云电脑电源管理操作 API (开机 / 重启 / 关机) —— 支持天翼云与移动云
  if (req.method === 'POST' && (pathname.startsWith('/api/accounts/') || pathname.startsWith('/api/ydpc/')) && (pathname.includes('/power/') || pathname.includes('/boot'))) {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }

    const parts = pathname.split('/');
    const accId = parts[3];
    const action = parts[5] || 'poweron'; // poweron / reboot / shutdown
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc) {
      jsonResponse(res, { error: '账号不存在' }, 404);
      return;
    }

    if (!canUserAccessAccount(session, acc)) {
      jsonResponse(res, { error: '权限不足：无权操作该账号' }, 403);
      return;
    }

    const body = await parseJsonBody(req).catch(() => ({}));
    const client = getClient(acc);
    try {
      const actionLower = (action || '').toLowerCase();
      let desktopId = parsedUrl.searchParams.get('desktopId') || body.userServiceId || body.desktopId || '';

      // 移动云电脑电源管理分支
      if (acc.platform === 'ydpc') {
        const targetUsid = desktopId || acc.vms?.[0]?.userServiceId || acc.desktops?.[0]?.userServiceId;
        const resPower = await client.controlPower(targetUsid, actionLower);
        jsonResponse(res, resPower);
        return;
      }

      // 移动公众（ecloud）：电源控制走平台官方 operate 通道（2026-09-28 接入，真机验证可受理）。
      // 协议取值来自官方 asar 客户端逆向：available=开机（后端不认识 startup/powerOn）/ shutdown / restart。
      // 措辞纪律：成功只报"平台已受理"，受理 ≠ 已生效；最终状态以平台状态刷新为准。
      if (acc.platform === 'ecloud') {
        const targetInstance = desktopId || acc.desktops?.[0]?.instanceId || '';
        if (!targetInstance) {
          jsonResponse(res, { error: '未指定云电脑（缺少 instanceId），请先「同步桌面」' }, 400);
          return;
        }
        const opMap = {
          poweron: 'available', boot: 'available', start: 'available', awake: 'available',
          shutdown: 'shutdown', poweroff: 'shutdown', reboot: 'restart', restart: 'restart',
        };
        const operate = opMap[actionLower];
        if (!operate) {
          jsonResponse(res, { error: `不支持的电源操作: ${actionLower}（仅 poweron/shutdown/reboot）` }, 400);
          return;
        }
        const resPower = await client.powerDesktop(targetInstance, operate);
        jsonResponse(res, resPower);
        return;
      }

      // 天翼云电脑电源管理分支
      if (!desktopId) {
        try {
          const desktops = await client.getDesktops();
          if (desktops && desktops.length > 0) {
            desktopId = desktops[0].objId || desktops[0].desktopId;
          }
        } catch (e) {}
      }

      if (!desktopId) {
        desktopId = client.metrics.desktopId || acc.stats?.desktopId || '';
      }

      if (!desktopId && actionLower !== 'poweron') {
        jsonResponse(res, { error: '未检测到可用云电脑' }, 400);
        return;
      }

      const resPower = await client.controlPower(desktopId, action);
      if (resPower.success) {
        // 核心联动：如果是用户在电源管理主动关机，自动关闭保活开关并打上主动关机标记
        if (actionLower === 'shutdown' || actionLower === 'poweroff') {
          acc.features = acc.features || {};
          acc.features.keepAlive = false;
          acc.manualShutdown = true;
          acc.stats = acc.stats || {};
          acc.stats.keepAliveStatus = 'offline';
          saveConfig(appConfig);
          client.stopKeepAliveWorker();
          appendLog('System', `[${acc.name}] 用户主动关机，已自动关闭保活开关，机器将维持关机。`, 'info');
        } else if (actionLower === 'poweron' || actionLower === 'start' || actionLower === 'awake') {
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
      jsonResponse(res, { error: e.message }, 400);
    }
    return;
  }

  // 独立状态验证：用独立轮询判定"保活是否真的有效"（旁路核验，不复用保活动作的结论）
  if (req.method === 'POST' && pathname.startsWith('/api/ydpc/') && pathname.includes('/verify-keepalive')) {
    const session = getSessionFromReq(req);
    if (!session) { jsonResponse(res, { error: '未登录' }, 401); return; }
    const accId = pathname.split('/')[3];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc || !canUserAccessAccount(session, acc)) { jsonResponse(res, { error: '账号不存在或无权操作' }, 403); return; }
    const body = await parseJsonBody(req);
    const client = getClient(acc);
    try {
      const durationSec = Math.min(600, Math.max(15, parseInt(body.durationSec) || 60));
      const intervalSec = Math.min(120, Math.max(5, parseInt(body.intervalSec) || 15));
      const report = await client.verifyKeepAliveEffect(durationSec, intervalSec);
      jsonResponse(res, report);
    } catch (e) {
      jsonResponse(res, { error: e.message }, 400);
    }
    return;
  }

  if (req.method === 'POST' && pathname.startsWith('/api/ydpc/') && pathname.includes('/cag-ping')) {
    const session = getSessionFromReq(req);
    if (!session) { jsonResponse(res, { error: '未登录' }, 401); return; }
    const accId = pathname.split('/')[3];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc || !canUserAccessAccount(session, acc)) { jsonResponse(res, { error: '账号不存在或无权操作' }, 403); return; }
    const body = await parseJsonBody(req);
    const client = getClient(acc);
    try {
      const result = await client.pingCag(body.userServiceId, 3);
      jsonResponse(res, result);
    } catch (e) {
      jsonResponse(res, { error: e.message }, 400);
    }
    return;
  }

  if (req.method === 'POST' && pathname.startsWith('/api/ydpc/') && pathname.includes('/heartbeat')) {
    const session = getSessionFromReq(req);
    if (!session) { jsonResponse(res, { error: '未登录' }, 401); return; }
    const accId = pathname.split('/')[3];
    const acc = appConfig.accounts.find(a => a.id === accId);
    if (!acc || !canUserAccessAccount(session, acc)) { jsonResponse(res, { error: '账号不存在或无权操作' }, 403); return; }
    const body = await parseJsonBody(req);
    const client = getClient(acc);
    try {
      const result = await client.sendHeartbeat(body.userServiceId);
      jsonResponse(res, result);
    } catch (e) {
      jsonResponse(res, { error: e.message }, 400);
    }
    return;
  }

  // 17. 系统全局设置（仅管理员可访问与修改）
  if (req.method === 'GET' && pathname === '/api/settings') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }
    if (session.role !== 'admin') {
      jsonResponse(res, { error: '权限不足：仅超级管理员可查看全局系统设置' }, 403);
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
      const channel = body.notify.channel || 'webhook';
      if (body.notify.enabled && !isValidWebhookTarget(channel, targetUrl)) {
        jsonResponse(res, { error: '安全拦截：禁止设置内网/私有IP或目标格式非法！' }, 400);
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

  // 17.5 个人通知偏好设置 API (所有登录用户可用，包含普通用户和管理员)
  if (req.method === 'GET' && pathname === '/api/user/notify') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }
    const userNotify = authManager.getUserNotify(session.userId) || {
      enabled: false,
      channel: 'webhook',
      webhookUrl: '',
      customTitleTemplate: '',
      customContentTemplate: ''
    };
    jsonResponse(res, userNotify);
    return;
  }

  if (req.method === 'PUT' && pathname === '/api/user/notify') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }
    const body = await parseJsonBody(req);
    const channel = body.channel || 'webhook';
    const webhookUrl = String(body.webhookUrl || '').trim();
    if (body.enabled && webhookUrl && !isValidWebhookTarget(channel, webhookUrl)) {
      jsonResponse(res, { error: '安全拦截：禁止设置内网/私有IP或目标格式非法！' }, 400);
      return;
    }
    const ok = authManager.updateUserNotify(session.userId, body);
    if (ok) {
      appendLog('Auth', `用户 [${session.username}] 更新了个人消息通知配置`, 'info');
      if (session.role === 'admin') {
        appConfig.settings.notify = { ...body };
        saveConfig(appConfig);
      }
      jsonResponse(res, { success: true, notify: authManager.getUserNotify(session.userId) });
    } else {
      jsonResponse(res, { error: '用户不存在' }, 404);
    }
    return;
  }

  // 17.6 个人通知推送测试 API (所有登录用户可用)
  if (req.method === 'POST' && pathname === '/api/user/notify/test') {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, { error: '未授权：请登录后再操作' }, 401);
      return;
    }
    const body = await parseJsonBody(req);
    const channel = body.channel || 'webhook';
    const testUrl = (body.webhookUrl || '').trim();
    if (!isValidWebhookTarget(channel, testUrl)) {
      jsonResponse(res, { success: false, message: '安全拦截：目标地址为内网/私有IP或格式非法，已被系统拒绝！' }, 400);
      return;
    }
    const testSettings = {
      notify: {
        enabled: true,
        channel: channel,
        webhookUrl: testUrl,
        secret: body.secret || '',
        customTitleTemplate: body.customTitleTemplate || '',
        customContentTemplate: body.customContentTemplate || ''
      }
    };
    const resNotify = await sendNotification(
      testSettings,
      `天翼云控制中心 - [${session.username}] 个人测试推送`,
      '这是一条即时测试消息，证明您的专属消息推送通道已成功联通！',
      { account: '个人专属测试', task: '推送联通测试', status: '成功', points: '100' }
    );
    jsonResponse(res, resNotify);
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
    const channel = body.channel || appConfig.settings?.notify?.channel || 'webhook';
    const testUrl = (body.webhookUrl || appConfig.settings?.notify?.webhookUrl || '').trim();
    if (!isValidWebhookTarget(channel, testUrl)) {
      jsonResponse(res, { success: false, message: '安全拦截：目标地址为内网/本地私有地址或格式非法，已被系统拒绝！' }, 400);
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
      exportVersion: '2.1.3',
      exportTime: getBeijingTimeString(),
      exportedBy: session.username,
      role: session.role,
      settings: session.role === 'admin' ? appConfig.settings : undefined,
      accounts: exportAccounts.map(a => {
        if (a.platform === 'ecloud') {
          // 移动公众标准化导出（与 ydpc / ctyun 各自独立的分支，绝不混用字段语义）
          return {
            platform: 'ecloud',
            name: a.name || a.user,
            user: a.user,
            password: a.password || '',
            ecloudDeviceUid: a.ecloudDeviceUid || '',
            keepaliveInterval: parseInt(a.keepaliveInterval) || 300,
            enabled: a.enabled !== false,
            features: a.features || buildEcloudDefaultFeatures(),
            desktops: a.desktops || []
          };
        }
        const isYd = a.platform === 'ydpc' || !!a.accountType;
        if (isYd) {
          // 移动云电脑标准化导出 (明确标注 platform: ydpc，区分 main 和家亲主账号 / sub 独立子账号)
          return {
            platform: 'ydpc',
            accountType: a.accountType || 'main',
            name: a.name || a.user,
            user: a.user,
            password: a.password || '',
            deviceCode: a.deviceCode || '',
            keepaliveInterval: parseInt(a.keepaliveInterval) || 600,
            enabled: a.enabled !== false,
            features: a.features || { controlPlaneKeepalive: true, keepAlive: true },
            vms: a.vms || []
          };
        } else {
          // 天翼云电脑标准化导出 (明确标注 platform: ctyun，区分 qrcode 扫码绑定 / password 账密绑定)
          const isQr = !a.password;
          return {
            platform: 'ctyun',
            authMode: isQr ? 'qrcode' : 'password',
            name: a.name || a.user,
            user: a.user,
            password: a.password || '',
            deviceCode: a.deviceCode || '',
            displayConfig: a.displayConfig || { width: 2560, height: 1440, scale: 150 },
            enabled: a.enabled !== false,
            bound: a.bound !== false,
            features: a.features || { keepAlive: true, autoSign: true, aiChat: true, cloudHang: true, autoRedeem: false, autoBoot: true },
            redeemConfig: a.redeemConfig || { enabled: false, targetType: 'redeem' },
            desktops: a.desktops || []
          };
        }
      })
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
      if (!item.user) continue;

      // ── 平台归属判定 (第一优先级：显式 platform 标签绝对优先，绝不篡改) ──
      let isYdpc = false;
      let isEcloud = false;
      if (item.platform === 'ecloud') {
        isEcloud = true;
      } else if (item.platform === 'ydpc') {
        isYdpc = true;
      } else if (item.platform === 'ctyun') {
        isYdpc = false;
      } else {
        // 第二优先级：仅针对缺失 platform 字段的历史老版本备份，按特征严格判定
        const hasYdpcFeatures = item.features && (
          item.features.cagKeepAlive === true || item.features.sohoHeartbeat === true ||
          item.features.controlPlaneKeepalive === true || item.features.mqttKeepAlive === true
        );
        const hasCtyunFeatures = item.features && (item.features.autoSign !== undefined || item.features.aiChat !== undefined || item.features.cloudHang !== undefined || item.redeemConfig !== undefined);

        if (item.accountType === 'sub' || item.accountType === 'main') {
          isYdpc = true;
        } else if (hasYdpcFeatures && !hasCtyunFeatures) {
          isYdpc = true;
        } else if (Array.isArray(item.vms) && item.vms.length > 0) {
          isYdpc = true;
        } else if (typeof item.name === 'string' && item.name.includes('移动') && !item.name.includes('天翼')) {
          isYdpc = true;
        } else {
          isYdpc = false; // 默认天翼云
        }
      }

      const platformStr = isEcloud ? 'ecloud' : (isYdpc ? 'ydpc' : 'ctyun');

      // ── 天翼云登录模式判定 (authMode === 'qrcode' 或密码为空均视为扫码绑定) ──
      const isQrAccount = !isYdpc && (item.authMode === 'qrcode' || !item.password);

      // 如果是 merge，检查手机号/账号名是否已存在同平台账号
      const existing = appConfig.accounts.find(a => a.user === item.user && a.ownerId === targetOwnerId && (a.platform || 'ctyun') === platformStr);
      if (existing) {
        existing.name = item.name || existing.name;
        if (item.password) existing.password = item.password;
        if (isYdpc && item.accountType) existing.accountType = item.accountType;
        if (isYdpc && item.keepaliveInterval) existing.keepaliveInterval = item.keepaliveInterval;
        if (item.deviceCode) existing.deviceCode = item.deviceCode;
        if (isEcloud && item.ecloudDeviceUid) existing.ecloudDeviceUid = item.ecloudDeviceUid;
        if (isEcloud && item.keepaliveInterval) existing.keepaliveInterval = item.keepaliveInterval;
        if (item.displayConfig) existing.displayConfig = { ...existing.displayConfig, ...item.displayConfig };
        if (item.features) existing.features = { ...existing.features, ...item.features };
        if (item.redeemConfig) existing.redeemConfig = { ...existing.redeemConfig, ...item.redeemConfig };
        if (isYdpc && Array.isArray(item.vms) && item.vms.length > 0) existing.vms = item.vms;
        if (!isYdpc && Array.isArray(item.desktops) && item.desktops.length > 0) existing.desktops = item.desktops;
        importedCount++;
        continue;
      }

      const id = (isYdpc ? 'yd_' : (isEcloud ? 'ec_' : 'ct_')) + crypto.randomUUID().substring(0, 8);
      const newAcc = {
        id,
        platform: platformStr,
        ownerId: targetOwnerId,
        accountType: isYdpc ? (item.accountType || 'main') : undefined,
        name: item.name || item.user,
        user: item.user,
        password: item.password || '',
        deviceCode: item.deviceCode || generateDeviceCode(),
        ecloudDeviceUid: isEcloud ? (item.ecloudDeviceUid || crypto.randomUUID()) : undefined,
        keepaliveInterval: isYdpc ? (parseInt(item.keepaliveInterval) || 600) : (isEcloud ? (parseInt(item.keepaliveInterval) || 300) : undefined),
        displayConfig: item.displayConfig || { width: 2560, height: 1440, scale: 150 },
        enabled: item.enabled !== false,
        bound: isYdpc ? true : (item.bound !== false),
        sessionExpired: isQrAccount ? true : false,
        features: item.features || (isEcloud ? buildEcloudDefaultFeatures() : (isYdpc ? {
          keepAlive: true,
          controlPlaneKeepalive: true,
          dataPlaneKeepalive: true
        } : {
          keepAlive: true,
          autoSign: true,
          aiChat: true,
          cloudHang: true,
          autoRedeem: false,
          // 2026-09-28：移动云自动开机守护默认开启（用户拍板）
          autoBoot: true
        })),
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
        vms: isYdpc ? (item.vms || []) : [],
        desktops: !isYdpc ? (item.desktops || []) : [],
        stats: item.stats || {
          lastSignTime: '',
          lastAiChatTime: '',
          lastHangTime: '',
          hangMinutesToday: 0,
          points: 0,
          keepAliveStatus: isYdpc ? 'online' : (isQrAccount ? 'offline' : 'online'),
          lastError: ''
        }
      };
      appConfig.accounts.push(newAcc);
      importedCount++;

      // 自动唤醒长连接保活
      const client = getClient(newAcc);
      if (isYdpc) {
        client.refreshVms().then(() => {
          if (newAcc.enabled && newAcc.features?.keepAlive !== false) {
            client.startKeepAliveWorker();
          }
        }).catch(() => {});
      } else if (newAcc.password && newAcc.enabled && newAcc.features?.keepAlive !== false) {
        client.startKeepAliveWorker();
      }
    }

    // 管理员导入时若带 settings 则一并更新
    if (session.role === 'admin' && body.settings && typeof body.settings === 'object') {
      appConfig.settings = { ...appConfig.settings, ...body.settings };
      appendLog('System', `⚠️ 备份文件包含系统设置，已一并还原 (保活周期: ${appConfig.settings.keepAliveSeconds}s / 脉冲间隔: ${(appConfig.settings.pulseIntervalSeconds || (appConfig.settings.pulseIntervalMinutes || 45) * 60)}秒 / 触发时间: ${appConfig.settings.cron?.executeTime || '01:20'})。如与预期不符，请前往「系统设置」核对调整。`, 'warning');
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

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    const isDockerEnv = fs.existsSync('/.dockerenv') || process.env.CTYUN_DATA_DIR === '/app/data';
    console.log(`===========================================================`);
    console.log(`🚀 天翼云/移动云电脑全功能可视化管理平台已完全就绪！`);
    console.log(`👉 控制台访问地址: http://127.0.0.1:${PORT}`);
    console.log(`📁 数据存储目录: ${DATA_DIR} (${isDockerEnv ? 'Docker容器' : '物理机/虚拟机'})`);
    if (isDockerEnv) {
      try {
        const canary = path.join(DATA_DIR, '.volume_check');
        if (!fs.existsSync(canary)) {
          fs.writeFileSync(canary, `persisted_test=${new Date().toISOString()}\n`, 'utf8');
        }
      } catch (err) {
        console.warn(`⚠️ [存储警告] 数据目录 ${DATA_DIR} 写入异常，请检查宿主机挂载卷权限: ${err.message}`);
      }
    }
    console.log(`===========================================================`);
    const restoredLogs = bootstrapLogsFromDisk();
    if (restoredLogs > 0) console.log(`📜 已从磁盘回灌 ${restoredLogs} 条历史日志 (${LOG_DIR})`);
    appendLog('System', `控制台服务已就绪，当前加载 ${appConfig.accounts.length} 个账号（回灌历史日志 ${restoredLogs} 条）`, 'success');
  });
}

module.exports = {
  CtYunClient,
  appConfig,
  server,
  taskScheduler,
  initAllKeepAlive,
  // 【2026-09-24】导出权威开关解析与平台归属判定，供回归网做**行为断言**
  // （此前只能做静态文本断言；导出后可直接真实调用，防止"长得像但语义错了"）。
  resolveTaskEnabled,
  TASK_FEATURE_KEY,
  TASK_CN_NAME,
  ECLOUD_KEEPALIVE_TASKS,
  buildEcloudDefaultFeatures,
  inferLogPlatform
};
