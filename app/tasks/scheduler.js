const { executeNativeAiChat, executeNativeSign, executeNativeHang } = require('./native_tasks');

function getBeijingDate() {
  const d = new Date();
  return new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
}

function getBeijingDateStr() {
  const d = new Date();
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function getBeijingTimeString() {
  const d = new Date();
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

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
  constructor({ getAccounts, getSettings, getClient, appendLog, sendNotification, saveConfig }) {
    this.getAccounts = getAccounts;
    this.getSettings = getSettings;
    this.getClient = getClient;
    this.appendLog = appendLog;
    this.sendNotification = sendNotification;
    this.saveConfig = saveConfig;
    this.timer = null;
    this.lastTriggerMinute = '';
    this.lastCompletedDate = '';
    this.isRunning = false;
  }

  start() {
    this.appendLog('Scheduler', '⏰ 自动化调度引擎已启动 (准时时间点主导 + 30秒无缝巡检)...', 'success');
    // 立即计算并挂载下一次精准时间点延时器
    this.scheduleNextRun();
    // 同时启动轻量级 30 秒轮询看门狗：防止设置热更新失效、跨日兜底，并支持高级分项Cron自定义触发
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.heartbeatTick(), 30000);
    // 立即执行一次开机/重启检测
    setTimeout(() => this.checkStartupCatchup(), 2000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.nextRunTimer) {
      clearTimeout(this.nextRunTimer);
      this.nextRunTimer = null;
    }
  }

  getTargetTimes() {
    const settings = this.getSettings() || {};
    const cron = settings.cron || {};
    const rawTimes = cron.executeTime || cron.taskTime || '01:20';
    const list = rawTimes.split(/[,，\s]+/).map(t => t.trim()).filter(Boolean);
    return list.length > 0 ? list : ['01:20'];
  }

  /**
   * 开机或配置热更新时自检：检测今天是否已达成；若未达成且已过设定时间点，执行自动补跑兜底
   */
  async checkStartupCatchup() {
    const todayStr = getBeijingDateStr();
    const accounts = this.getAccounts() || [];

    let allDone = accounts.length > 0;
    for (const acc of accounts) {
      if (!acc.enabled) continue;
      const f = acc.features || {};
      const client = this.getClient(acc);
      try {
        await client.refreshOfficialTasks();
      } catch (e) {}
      const tasks = client?.metrics?.officialTasks || [];

      // 仅考核用户自身开启的功能项是否达成
      const loginTask = tasks.find(t => t.name.includes('登录AI云电脑'));
      const aiTask = tasks.find(t => t.name.includes('AI对话'));
      const hangTask = tasks.find(t => t.name.includes('使用1小时'));

      if (f.autoSign !== false && !(loginTask && (loginTask.status === 2 || loginTask.current >= loginTask.total))) {
        allDone = false;
        break;
      }
      if (f.aiChat !== false && !(aiTask && (aiTask.status === 2 || aiTask.current >= aiTask.total))) {
        allDone = false;
        break;
      }
      if (f.cloudHang !== false && !(hangTask && (hangTask.status === 2 || hangTask.current >= hangTask.total))) {
        allDone = false;
        break;
      }
    }

    if (allDone) {
      this.lastCompletedDate = todayStr;
      this.appendLog('Scheduler', `✅ 检测确认：所有账号已开启的自动化任务均已圆满达成，系统转入低功耗休眠，等待设定时间准时触发。`, 'success');
      return;
    }

    // 检查当前北京时间是否已达到或超过预设的目标时间
    const targetTimes = this.getTargetTimes();
    const bj = getBeijingDate();
    const currentVal = bj.getHours() * 60 + bj.getMinutes();

    let shouldCatchup = false;
    for (const t of targetTimes) {
      const parts = t.split(':').map(Number);
      const tVal = parts[0] * 60 + (parts[1] || 0);
      if (currentVal >= tVal) {
        shouldCatchup = true;
        break;
      }
    }

    if (shouldCatchup && this.lastCompletedDate !== todayStr) {
      this.appendLog('Scheduler', `🚀 准时补跑机制触发：当前时间 (${String(bj.getHours()).padStart(2, '0')}:${String(bj.getMinutes()).padStart(2, '0')}) 已达或超过预设时间点 (${targetTimes.join(', ')})，立即执行全自动任务...`, 'info');
      await this.runAllAccounts('catchup_or_scheduled');
    }
  }

  /**
   * 计算下次触发时间并挂载精确的延时器
   */
  scheduleNextRun() {
    if (this.nextRunTimer) {
      clearTimeout(this.nextRunTimer);
      this.nextRunTimer = null;
    }

    const targetTimes = this.getTargetTimes();
    const bj = getBeijingDate();
    const currentMs = bj.getTime();

    let nextTargetDate = null;
    for (const timeStr of targetTimes) {
      const [h, m] = timeStr.split(':').map(Number);
      const candidate = new Date(bj.getTime());
      candidate.setHours(h, m, 0, 0);
      if (candidate.getTime() > currentMs) {
        if (!nextTargetDate || candidate.getTime() < nextTargetDate.getTime()) {
          nextTargetDate = candidate;
        }
      }
    }

    if (!nextTargetDate) {
      const [h, m] = targetTimes[0].split(':').map(Number);
      const tomorrow = new Date(bj.getTime() + 24 * 3600 * 1000);
      tomorrow.setHours(h, m, 0, 0);
      nextTargetDate = tomorrow;
    }

    const delayMs = Math.max(1000, nextTargetDate.getTime() - currentMs);
    const targetH = String(nextTargetDate.getHours()).padStart(2, '0');
    const targetM = String(nextTargetDate.getMinutes()).padStart(2, '0');
    const hoursAway = (delayMs / 3600000).toFixed(1);

    this.appendLog('Scheduler', `⏰ 下一次自动化任务将在北京时间 ${targetH}:${targetM} 准时执行 (约 ${hoursAway} 小时后)。`, 'info');

    this.nextRunTimer = setTimeout(async () => {
      await this.runAllAccounts('point_in_time');
      this.scheduleNextRun();
    }, delayMs);
  }

  /**
   * 判断辅助规则是否启用且包含有效规则
   */
  hasActiveSubCronRules() {
    const settings = this.getSettings() || {};
    const cron = settings.cron || {};
    if (!cron.enableSubCron) return false;
    return !!(cron.signCron?.trim() || cron.aiChatCron?.trim() || cron.cloudHangCron?.trim() || cron.redeemCron?.trim());
  }

  /**
   * 30 秒巡检看门狗：负责准点分钟匹配、高级 Cron 触发以及热更新重调度
   */
  async heartbeatTick() {
    const bj = getBeijingDate();
    const currentMinKey = bj.toISOString().substring(0, 16); // YYYY-MM-DDTHH:mm
    if (this.lastTriggerMinute === currentMinKey) return;

    const currentHm = `${String(bj.getHours()).padStart(2, '0')}:${String(bj.getMinutes()).padStart(2, '0')}`;
    const targetTimes = this.getTargetTimes();
    const todayStr = getBeijingDateStr();

    const settings = this.getSettings() || {};
    const cron = settings.cron || {};
    const subCronActive = this.hasActiveSubCronRules();

    // 1. 如果未启用辅助规则，或者虽然启用了辅助规则但没有填写任何具体规则：
    // 则以【每日任务准时触发时间点 (主调度中心)】为主触发机制
    if (!subCronActive) {
      if (targetTimes.includes(currentHm)) {
        this.lastTriggerMinute = currentMinKey;
        if (this.lastCompletedDate !== todayStr) {
          this.appendLog('Scheduler', `⏰ 到达主调度中心每日任务准时触发时间点 [${currentHm}]，正在启动全自动流程...`, 'info');
          await this.runAllAccounts('scheduled_point');
          this.scheduleNextRun();
          return;
        }
      }
      return;
    }

    // 2. 如果启用了辅助规则且填写了具体 Cron 表达式：
    // 则严格以用户填写的各项辅助规则为准独立执行，未填写的分项则兜底遵循主调度中心时间
    const accounts = (this.getAccounts() || []).filter(a => a.enabled);

    // 2.1 每日签到打卡分项规则
    if (cron.signCron?.trim()) {
      if (shouldRunCron(cron.signCron.trim(), bj)) {
        this.lastTriggerMinute = currentMinKey;
        this.appendLog('Scheduler', `⏰ 触发分项辅助规则 [签到打卡] (Cron: ${cron.signCron})...`, 'info');
        for (const acc of accounts) {
          if (acc.features?.autoSign !== false) {
            const client = this.getClient(acc);
            executeNativeSign(client, acc, (src, msg, lvl) => this.appendLog(src, `[${acc.name}] ${msg}`, lvl)).catch(() => {});
          }
        }
      }
    } else if (targetTimes.includes(currentHm) && this.lastCompletedDate !== todayStr) {
      // 辅助规则未配置该项，按主时间点兜底
      for (const acc of accounts) {
        if (acc.features?.autoSign !== false) {
          const client = this.getClient(acc);
          executeNativeSign(client, acc, (src, msg, lvl) => this.appendLog(src, `[${acc.name}] ${msg}`, lvl)).catch(() => {});
        }
      }
    }

    // 2.2 AI 智能对话分项规则
    if (cron.aiChatCron?.trim()) {
      if (shouldRunCron(cron.aiChatCron.trim(), bj)) {
        this.lastTriggerMinute = currentMinKey;
        this.appendLog('Scheduler', `⏰ 触发分项辅助规则 [AI 对话] (Cron: ${cron.aiChatCron})...`, 'info');
        for (const acc of accounts) {
          if (acc.features?.aiChat !== false) {
            const client = this.getClient(acc);
            executeNativeAiChat(client, acc, (src, msg, lvl) => this.appendLog(src, `[${acc.name}] ${msg}`, lvl)).catch(() => {});
          }
        }
      }
    } else if (targetTimes.includes(currentHm) && this.lastCompletedDate !== todayStr) {
      // 辅助规则未配置该项，按主时间点兜底
      for (const acc of accounts) {
        if (acc.features?.aiChat !== false) {
          const client = this.getClient(acc);
          executeNativeAiChat(client, acc, (src, msg, lvl) => this.appendLog(src, `[${acc.name}] ${msg}`, lvl)).catch(() => {});
        }
      }
    }

    // 2.3 云电脑挂机守护分项规则
    if (cron.cloudHangCron?.trim()) {
      if (shouldRunCron(cron.cloudHangCron.trim(), bj)) {
        this.lastTriggerMinute = currentMinKey;
        this.appendLog('Scheduler', `⏰ 触发分项辅助规则 [云电脑挂机] (Cron: ${cron.cloudHangCron})...`, 'info');
        for (const acc of accounts) {
          if (acc.features?.cloudHang !== false) {
            const client = this.getClient(acc);
            executeNativeHang(client, acc, (src, msg, lvl) => this.appendLog(src, `[${acc.name}] ${msg}`, lvl)).catch(() => {});
          }
        }
      }
    }

    // 2.4 自动兑换与抽奖分项规则
    if (cron.redeemCron?.trim()) {
      if (shouldRunCron(cron.redeemCron.trim(), bj)) {
        this.lastTriggerMinute = currentMinKey;
        this.appendLog('Scheduler', `⏰ 触发分项辅助规则 [自动兑换/抽奖] (Cron: ${cron.redeemCron})...`, 'info');
        for (const acc of accounts) {
          if (acc.features?.autoRedeem) {
            const client = this.getClient(acc);
            client.getRewards().catch(() => {});
          }
        }
      }
    }
  }

  /**
   * 执行所有账号的完整自动化任务流
   */
  async runAllAccounts(reason = 'scheduled') {
    if (this.isRunning) return;
    this.isRunning = true;

    const todayStr = getBeijingDateStr();
    const accounts = (this.getAccounts() || []).filter(a => a.enabled);

    this.appendLog('Scheduler', `🔔 开始按序执行 ${accounts.length} 个云电脑的原生任务流程 (触发来源: ${reason})...`, 'info');

    const summaryResults = [];

    for (const acc of accounts) {
      const client = this.getClient(acc);
      const accSummary = { name: acc.name, sign: false, aiChat: false, hang: false };

      // 若用户当前正在通过网页浏览器操控该云电脑，为避免互踢，自动跳过该账号的本次自动化，保持避让！
      if (client?.isWebUserActive) {
        this.appendLog('Scheduler', `[${acc.name}] 用户当前正在浏览器中远程操控云电脑，为避免会话冲突，本次自动化调度主动避让跳过，等用户关闭页面后再继续。`, 'info');
        continue;
      }

      try {
        // 1. 底层 WSS 长连接保活守护 (避免被踢) —— 仅在保活开关开启时拉起，尊重用户主动关机保护
        if (!client.wsAlive && acc.features?.cloudHang !== false && acc.features?.keepAlive !== false) {
          client.startKeepAliveWorker();
        }

        // 2. 原生登录打卡
        if (acc.features?.autoSign !== false) {
          try {
            await executeNativeSign(client, acc, (src, msg, lvl) => this.appendLog(src, `[${acc.name}] ${msg}`, lvl));
            acc.stats.lastSignTime = getBeijingTimeString();
            accSummary.sign = true;
          } catch (e) {
            this.appendLog('Sign', `[${acc.name}] 打卡未达标: ${e.message}`, 'error');
          }
        }

        // 3. 原生毫秒级 AI 智能对话 (彻底剔除 Chromium)
        if (acc.features?.aiChat !== false) {
          try {
            await executeNativeAiChat(client, acc, (src, msg, lvl) => this.appendLog(src, `[${acc.name}] ${msg}`, lvl));
            acc.stats.lastAiChatTime = getBeijingTimeString();
            accSummary.aiChat = true;
          } catch (e) {
            this.appendLog('AIChat', `[${acc.name}] AI 对话未达标: ${e.message}`, 'error');
          }
        }

        // 4. 原生云电脑挂机守护检测
        if (acc.features?.cloudHang !== false) {
          try {
            const hangRes = await executeNativeHang(client, acc, (src, msg, lvl) => this.appendLog(src, `[${acc.name}] ${msg}`, lvl));
            accSummary.hang = (hangRes && hangRes.isCompleted === true);
          } catch (e) {
            this.appendLog('Hang', `[${acc.name}] 挂机状态检测异常: ${e.message}`, 'error');
          }
        }

        // 5. 自动抽奖/商城奖品同步
        if (acc.features?.autoRedeem) {
          try {
            const list = await client.getRewards();
            this.appendLog('Redeem', `[${acc.name}] 奖品列表已拉取，当前商城奖品数: ${list.length}`, 'info');
          } catch (e) {}
        }

        await client.refreshOfficialTasks();
        summaryResults.push(accSummary);

      } catch (err) {
        this.appendLog('Scheduler', `[${acc.name}] 任务执行链路异常: ${err.message}`, 'error');
      }

      await new Promise(r => setTimeout(r, 1000));
    }

    // 严格判定：只有当所有账号已开启的全部任务（包括挂机满 1 小时）都真正达成时，才标记今日流程圆满完成
    let allAccountsFullyDone = true;
    for (const acc of accounts) {
      const client = this.getClient(acc);
      const tasks = client?.metrics?.officialTasks || [];
      const loginTask = tasks.find(t => t.name.includes('登录AI云电脑'));
      const aiTask = tasks.find(t => t.name.includes('AI对话'));
      const hangTask = tasks.find(t => t.name.includes('使用1小时'));

      if (acc.features?.autoSign !== false && !(loginTask && (loginTask.status === 2 || loginTask.current >= loginTask.total))) {
        allAccountsFullyDone = false;
      }
      if (acc.features?.aiChat !== false && !(aiTask && (aiTask.status === 2 || aiTask.current >= aiTask.total))) {
        allAccountsFullyDone = false;
      }
      if (acc.features?.cloudHang !== false && !(hangTask && (hangTask.status === 2 || hangTask.current >= hangTask.total))) {
        allAccountsFullyDone = false;
      }
    }

    if (allAccountsFullyDone) {
      this.lastCompletedDate = todayStr;
      this.appendLog('Scheduler', `🎉 今日云电脑定时任务流程已全部顺利执行完成！做完即标记今日达成，当天绝不再空转。`, 'success');
    } else {
      this.appendLog('Scheduler', `⚡ 今日定时自动化流程触发完毕，云电脑长连接正在后台持续挂机累加时长直至满 1 小时达成...`, 'info');
    }

    if (this.saveConfig) this.saveConfig();
    
    // 发送 Webhook 汇总通知
    const detailText = summaryResults.map(r => `• ${r.name}: 打卡[${r.sign ? 'OK' : '跳过'}], AI对话[${r.aiChat ? 'OK' : '跳过'}], 挂机保活[${r.hang ? 'OK' : '跳过'}]`).join('\n');
    this.sendNotification(
      this.getSettings(),
      `🌟 天翼云电脑今日任务执行汇总 (${todayStr})`,
      `今日自动化任务已准点完成：\n${detailText}\n所有任务均为原生协议极速直连，零 Chromium 内存占用！`
    );

    this.isRunning = false;
  }
}

module.exports = { TaskScheduler };
