function matchCronField(field, val) {
  if (field === '*') return true;
  const parts = field.split(',');
  for (const part of parts) {
    if (part.includes('/')) {
      const [range, step] = part.split('/');
      const stepNum = parseInt(step, 10);
      if (range === '*') {
        if (val % stepNum === 0) return true;
      } else {
        const [start, end] = range.split('-').map(Number);
        if (val >= start && val <= end && (val - start) % stepNum === 0) return true;
      }
    } else if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      if (val >= start && val <= end) return true;
    } else {
      if (parseInt(part, 10) === val) return true;
    }
  }
  return false;
}

function shouldRunCron(cronExpr, date = new Date()) {
  if (!cronExpr) return false;
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minStr, hourStr, domStr, monthStr, dowStr] = parts;
  const min = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1;
  const dow = date.getDay();

  return matchCronField(minStr, min) &&
         matchCronField(hourStr, hour) &&
         matchCronField(domStr, dom) &&
         matchCronField(monthStr, month) &&
         matchCronField(dowStr, dow);
}

class TaskScheduler {
  constructor({ getAccounts, getSettings, getClient, ocrEngine, appendLog, sendNotification }) {
    this.getAccounts = getAccounts;
    this.getSettings = getSettings;
    this.getClient = getClient;
    this.ocrEngine = ocrEngine;
    this.appendLog = appendLog;
    this.sendNotification = sendNotification;
    this.lastTriggerMinute = ''; // 记录上一次匹配分钟，防 1 分钟内重复触发
    this.timer = null;
    this.activeHangAccountIds = new Set(); // 正在执行挂机的账号，避免并发冲突
  }

  start() {
    this.appendLog('Scheduler', '⏰ 内置定时任务调度器已成功启动并开始监听 Cron 表达式...', 'success');
    this.timer = setInterval(() => this.checkAndRun(), 30000); // 每 30 秒检查一次
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async checkAndRun() {
    const now = new Date();
    const currentMinKey = now.toISOString().substring(0, 16); // 精确到分钟 YYYY-MM-DDTHH:mm
    if (this.lastTriggerMinute === currentMinKey) return;
    this.lastTriggerMinute = currentMinKey;

    const settings = this.getSettings() || {};
    const cron = settings.cron || {};
    const accounts = this.getAccounts() || [];

    const signCron = cron.signCron || '0 2 * * *';
    const aiChatCron = cron.aiChatCron || '0 3,20 * * *';
    const hangCron = cron.cloudHangCron || '0 4,6 * * *';
    const redeemCron = cron.redeemCron || '0 7 * * *';

    // 1. 定时打卡检查
    if (shouldRunCron(signCron, now)) {
      this.appendLog('Scheduler', `⏰ 命中定时表达式，自动触发【每日签到打卡】任务 (${signCron})...`, 'info');
      for (const acc of accounts) {
        if (acc.enabled && acc.features?.autoSign !== false) {
          this.runAccountSign(acc);
        }
      }
    }

    // 2. 定时 AI 对话检查
    if (shouldRunCron(aiChatCron, now)) {
      this.appendLog('Scheduler', `⏰ 命中定时表达式，自动触发【AI 对话积分】任务 (${aiChatCron})...`, 'info');
      for (const acc of accounts) {
        if (acc.enabled && acc.features?.aiChat !== false) {
          this.runAccountAiChat(acc);
        }
      }
    }

    // 3. 定时挂机检查：如果到了指定的时间点（如 04:00, 06:00），或者账号开启了挂机且今日官方进度未达 3600 秒，自动开启后台保姆式挂机！
    const isCronMatched = shouldRunCron(hangCron, now);
    for (const acc of accounts) {
      if (acc.enabled && acc.features?.cloudHang !== false) {
        const client = this.getClient(acc);
        const hangTask = client.metrics.officialTasks?.find(t => t.name.includes('使用1小时'));
        const currentSec = hangTask ? (hangTask.current || 0) : (acc.stats?.hangMinutesToday || 0) * 60;
        
        // 当命中定时点，或者每小时检测发现今天还未挂满 1 小时 (3600秒) 时，自动静默拉起挂机补足！
        if (isCronMatched || (now.getMinutes() === 10 && currentSec < 3600)) {
          if (!this.activeHangAccountIds.has(acc.id)) {
            this.appendLog('Scheduler', `⏰ 自动守护挂机触发: [${acc.name}] 当前官方挂机进度 ${currentSec}/3600秒，正在自动在后台保持运行补足时长...`, 'info');
            this.runAccountHang(acc);
          }
        }
      }
    }

    // 4. 定时兑换检查
    if (shouldRunCron(redeemCron, now)) {
      this.appendLog('Scheduler', `⏰ 命中定时表达式，自动触发【自动兑换/抽奖】检查 (${redeemCron})...`, 'info');
      for (const acc of accounts) {
        if (acc.enabled && acc.features?.autoRedeem) {
          this.runAccountRedeem(acc);
        }
      }
    }
  }

  async runAccountSign(acc) {
    const { executeRealHang } = require('./real_tasks');
    const client = this.getClient(acc);
    this.appendLog('Sign', `[${acc.name}] 正在执行定时打卡...`, 'info');
    try {
      const displayCfg = acc.displayConfig || { width: 2560, height: 1440, scale: 150 };
      await executeRealHang(acc.user, acc.password, this.ocrEngine, 15, displayCfg, (src, msg, lvl) => this.appendLog(src, `[${acc.name}] ${msg}`, lvl));
      acc.stats.lastSignTime = new Date().toISOString().replace('T', ' ').substring(0, 19);
      await client.refreshOfficialTasks();
      this.appendLog('Sign', `[${acc.name}] 定时打卡成功！官方积分已刷新`, 'success');
      this.sendNotification(this.getSettings(), `✅ 定时打卡成功 - ${acc.name}`, `账号 [${acc.name}] 每日登录打卡任务已自动完成。`);
    } catch (e) {
      this.appendLog('Sign', `[${acc.name}] 定时打卡异常: ${e.message}`, 'error');
    }
  }

  async runAccountAiChat(acc) {
    const { executeRealAiChat } = require('./real_tasks');
    const client = this.getClient(acc);
    this.appendLog('AIChat', `[${acc.name}] 正在执行定时 AI 对话任务...`, 'info');
    try {
      await executeRealAiChat(acc.user, acc.password, this.ocrEngine, (src, msg, lvl) => this.appendLog(src, `[${acc.name}] ${msg}`, lvl));
      acc.stats.lastAiChatTime = new Date().toISOString().replace('T', ' ').substring(0, 19);
      await client.refreshOfficialTasks();
      this.appendLog('AIChat', `[${acc.name}] 定时 AI 对话达成！已获取今日 100 积分奖励`, 'success');
      this.sendNotification(this.getSettings(), `✅ AI 对话任务完成 - ${acc.name}`, `账号 [${acc.name}] 定时 AI 智能对话已完成，100 积分已入账。`);
    } catch (e) {
      this.appendLog('AIChat', `[${acc.name}] 定时 AI 对话异常: ${e.message}`, 'error');
    }
  }

  async runAccountHang(acc) {
    if (this.activeHangAccountIds.has(acc.id)) return;
    this.activeHangAccountIds.add(acc.id);

    const { executeRealHang } = require('./real_tasks');
    const client = this.getClient(acc);
    this.appendLog('Hang', `[${acc.name}] 正在启动自动云电脑挂机...`, 'info');
    try {
      if (!client.wsAlive) client.startKeepAliveWorker();
      const displayCfg = acc.displayConfig || { width: 2560, height: 1440, scale: 150 };
      // 自动挂机单次保持 300 秒 (5分钟)，后台温和累加
      await executeRealHang(acc.user, acc.password, this.ocrEngine, 300, displayCfg, (src, msg, lvl) => this.appendLog(src, `[${acc.name}] ${msg}`, lvl));
      acc.stats.lastHangTime = new Date().toISOString().replace('T', ' ').substring(0, 19);
      await client.refreshOfficialTasks();
      this.appendLog('Hang', `[${acc.name}] 自动挂机保持完成，已累加天翼云时长！`, 'success');
    } catch (e) {
      this.appendLog('Hang', `[${acc.name}] 自动挂机异常: ${e.message}`, 'error');
    } finally {
      this.activeHangAccountIds.delete(acc.id);
    }
  }

  async runAccountRedeem(acc) {
    const client = this.getClient(acc);
    const cfg = acc.redeemConfig || {};
    this.appendLog('Redeem', `[${acc.name}] 正在检查自动兑换策略...`, 'info');
    try {
      const rewards = await client.getRewards();
      this.appendLog('Redeem', `[${acc.name}] 商城查询就绪，共有 ${rewards.length} 种奖品`, 'info');
    } catch (e) {
      this.appendLog('Redeem', `[${acc.name}] 兑换检查异常: ${e.message}`, 'error');
    }
  }
}

module.exports = { TaskScheduler, shouldRunCron };
