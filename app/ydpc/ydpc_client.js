const { SohoClient } = require('./soho_client');
const { performCagAuthHold } = require('./cag_client');
const { bootYdpcVmUnified } = require('./boot_engine');

function getBeijingTimeString() {
  const d = new Date();
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function getBeijingTimeOnly() {
  const d = new Date();
  return d.toLocaleTimeString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function isYdpcVmOff(vm) {
  if (!vm) return false;
  const st = String(vm.vmStatus || vm.vmStatusShow || '').trim();
  if (st.includes('关机') || st.includes('停止') || st.includes('未开机') || st.includes('到期') || st.includes('未知')) return true;
  if (st === '23' || st === '16' || st === '0') return true;
  if (vm.vmStatus === 23 || vm.vmStatus === 16 || vm.vmStatus === 0 || vm.vmStatusCode === 23 || vm.vmStatusCode === 16 || vm.vmStatusCode === 0) return true;
  return false;
}

class YdpcClient {
  constructor(account, { appendLog, sendNotification, saveConfig }) {
    this.account = account;
    this.appendLog = appendLog || (() => {});
    this.sendNotification = sendNotification || (() => {});
    this.saveConfig = saveConfig || (() => {});

    this.sohoClient = new SohoClient({
      deviceId: account.deviceCode,
      accountType: account.accountType || 'main'
    });

    this.metrics = {
      status: 'offline', // 'online' | 'offline'
      vmStatus: account.stats?.vmStatus || '未知',
      durationMode: account.stats?.durationMode || 'permanent',
      remainHours: account.stats?.remainHours || 0,
      remainText: account.stats?.remainText || '♾️ 永久使用',
      lastHeartbeatTime: account.stats?.lastKeepAliveTime || '',
      lastHeartbeatResult: '保活巡检待命中',
      successCount: 0,
      errorCount: 0,
      vms: account.vms || []
    };

    this.workerRunning = false;
    this.loopTimer = null;
  }

  async login() {
    const accName = this.account.name || this.account.user;
    try {
      this.appendLog('SOHO', `[${accName}] 正在向中国移动 SOHO 认证中心登录 (类型: ${this.account.accountType === 'sub' ? '独立子账号' : '和家亲主账号'})...`, 'info', accName, 'ydpc');
      const res = await this.sohoClient.login(this.account.user, this.account.password, this.account.accountType || 'main');
      this.appendLog('SOHO', `[${accName}] ✅ SOHO 鉴权登录成功 (UserId: ${res.userId})`, 'success', accName, 'ydpc');
      return { success: true, data: res };
    } catch (err) {
      this.appendLog('SOHO', `[${accName}] ❌ SOHO 登录失败: ${err.message}`, 'error', accName, 'ydpc');
      return { success: false, error: err.message };
    }
  }

  async refreshVms() {
    const accName = this.account.name || this.account.user;
    try {
      if (!this.sohoClient.sohoToken) {
        await this.login();
      }
      const vms = await this.sohoClient.listCloudPcs();
      this.account.vms = vms;
      this.metrics.vms = vms;

      if (vms.length > 0) {
        const first = vms[0];
        const anyRunning = vms.some(v => !isYdpcVmOff(v));
        this.metrics.status = anyRunning ? 'online' : 'offline';
        this.metrics.vmStatus = first.vmStatus;
        this.metrics.durationMode = first.durationMode;
        this.metrics.remainHours = first.remainHours;
        this.metrics.remainText = first.remainText;
        
        this.account.stats = this.account.stats || {};
        this.account.stats.keepAliveStatus = this.metrics.status;
        this.account.stats.vmStatus = first.vmStatus;
        this.account.stats.durationMode = first.durationMode;
        this.account.stats.remainHours = first.remainHours;
        this.account.stats.remainText = first.remainText;

        if (!anyRunning) {
          this.metrics.lastHeartbeatResult = `云电脑处于已关机状态 (${first.remainText || ''})`;
        }
      }
      this.saveConfig();
      return vms;
    } catch (err) {
      this.appendLog('SOHO', `[${accName}] 刷新云电脑列表异常: ${err.message}`, 'error', accName, 'ydpc');
      return this.account.vms || [];
    }
  }

  async sendHeartbeat(userServiceId) {
    const accName = this.account.name || this.account.user;
    const usid = userServiceId || this.account.vms?.[0]?.userServiceId;
    if (!usid) throw new Error('未找到有效的 userServiceId');

    const currentVm = (this.account.vms || []).find(v => String(v.userServiceId) === String(usid));
    if (currentVm && isYdpcVmOff(currentVm)) {
      this.metrics.status = 'offline';
      if (this.account.stats) this.account.stats.keepAliveStatus = 'offline';
      this.metrics.lastHeartbeatResult = `云电脑 [${currentVm.vmName}] 处于已关机状态 (待命中)`;
      this.appendLog('SOHO', `[${accName}][${currentVm.vmName}] 云电脑当前处于已关机状态，心跳守护待命中。`, 'info', accName, 'ydpc');
      return { success: true, message: '云电脑处于关机状态' };
    }

    try {
      if (!this.sohoClient.sohoToken) {
        await this.login();
      }
      const res = await this.sohoClient.heartbeat(usid);
      const nowStr = getBeijingTimeOnly();
      this.metrics.status = 'online';
      if (this.account.stats) this.account.stats.keepAliveStatus = 'online';
      this.metrics.lastHeartbeatTime = nowStr;
      this.metrics.lastHeartbeatResult = `SOHO 心跳保持活跃 (${nowStr})`;
      this.appendLog('SOHO', `[${accName}] 💓 SOHO 心跳保持成功 (userServiceId: ${usid})`, 'info', accName, 'ydpc');
      return res;
    } catch (err) {
      this.metrics.status = 'offline';
      if (this.account.stats) this.account.stats.keepAliveStatus = 'offline';
      this.metrics.lastHeartbeatResult = `心跳异常: ${err.message}`;
      throw err;
    }
  }

  async pingCag(userServiceId, holdSeconds = 3) {
    const accName = this.account.name || this.account.user;
    const usid = userServiceId || this.account.vms?.[0]?.userServiceId;
    if (!usid) throw new Error('未找到有效的 userServiceId');

    const currentVm = (this.account.vms || []).find(v => String(v.userServiceId) === String(usid));
    if (currentVm && isYdpcVmOff(currentVm)) {
      this.metrics.status = 'offline';
      if (this.account.stats) this.account.stats.keepAliveStatus = 'offline';
      this.metrics.lastHeartbeatResult = `云电脑 [${currentVm.vmName}] 处于已关机状态 (待命中)`;
      return { success: false, message: '云电脑处于关机状态' };
    }

    try {
      if (!this.sohoClient.sohoToken) {
        await this.login();
      }
      const firmAuth = await this.sohoClient.getFirmAuth(usid);
      this.appendLog('CAG', `[${accName}] 正在向中兴 CAG 网关 (${firmAuth.cagIp}:${firmAuth.cagPort}) 发起 ZTEC TCP 三阶段握手...`, 'info', accName, 'ydpc');

      const cagRes = await performCagAuthHold(firmAuth, holdSeconds);
      const nowStr = getBeijingTimeOnly();
      
      this.metrics.status = 'online';
      this.metrics.lastHeartbeatTime = nowStr;
      this.metrics.lastHeartbeatResult = `ZTEC CAG 握手 200 OK (${nowStr})`;
      this.metrics.successCount++;

      this.account.stats = this.account.stats || {};
      this.account.stats.keepAliveStatus = 'online';
      this.account.stats.lastKeepAliveTime = getBeijingTimeString();
      this.saveConfig();

      this.appendLog('CAG', `[${accName}] 🟢 ZTEC CAG TCP 三阶段握手成功，网关返回 200 OK！`, 'success', accName, 'ydpc');
      return cagRes;
    } catch (err) {
      this.metrics.status = 'offline';
      if (this.account.stats) this.account.stats.keepAliveStatus = 'offline';
      const errMsg = err.message || '';
      if (errMsg.includes('用完') || errMsg.includes('已用尽') || errMsg.includes('到期') || errMsg.includes('欠费')) {
        this.metrics.lastHeartbeatResult = `时长已耗尽 (${errMsg})`;
      } else {
        this.metrics.lastHeartbeatResult = `CAG 握手受阻: ${errMsg}`;
      }
      this.saveConfig();
      throw err;
    }
  }

  async bootVm(userServiceId) {
    return await this.controlPower(userServiceId, 'poweron');
  }

  async controlPower(userServiceId, action = 'poweron') {
    const accName = this.account.name || this.account.user;
    const usid = userServiceId || this.account.vms?.[0]?.userServiceId;
    if (!usid) throw new Error('未找到有效的 userServiceId');

    if (!this.sohoClient.sohoToken) {
      await this.login();
    }

    const actionLower = (action || '').toLowerCase();
    if (actionLower === 'reboot') {
      this.appendLog('SOHO', `[${accName}] 正在向移动云下发【重启】指令 (userServiceId: ${usid})...`, 'info', accName, 'ydpc');
      const res = await this.sohoClient.rebootVm(usid);
      this.appendLog('SOHO', `[${accName}] ✅ 云电脑重启指令已生效！`, 'success', accName, 'ydpc');
      setTimeout(() => this.refreshVms().catch(() => {}), 3000);
      return res;
    } else if (actionLower === 'shutdown' || actionLower === 'poweroff') {
      this.appendLog('SOHO', `[${accName}] 正在向移动云下发【关机/断开】指令 (userServiceId: ${usid})...`, 'info', accName, 'ydpc');
      const res = await this.sohoClient.shutdownVm(usid);
      this.appendLog('SOHO', `[${accName}] ✅ 云电脑关机/断开指令已生效！`, 'success', accName, 'ydpc');
      setTimeout(() => this.refreshVms().catch(() => {}), 2000);
      return res;
    } else {
      // poweron / awake / start: 走 SC/ZTE 自适应融合开机
      this.appendLog('SOHO', `[${accName}] 正在执行移动云【开机/唤醒】指令 (userServiceId: ${usid})...`, 'info', accName, 'ydpc');
      let firmAuth = null;
      try {
        firmAuth = await this.sohoClient.getFirmAuth(usid);
      } catch (e) {}

      const currentVm = (this.account.vms || []).find(v => String(v.userServiceId) === String(usid)) || {};
      const res = await bootYdpcVmUnified(this.sohoClient, firmAuth, usid, currentVm);
      this.appendLog('SOHO', `[${accName}] ✅ ${res.message || '云电脑开机/激活指令已成功下达！'}`, 'success', accName, 'ydpc');
      setTimeout(() => this.refreshVms().catch(() => {}), 3000);
      return res;
    }
  }

  startKeepAliveWorker() {
    if (this.workerRunning) return;
    this.workerRunning = true;
    const accName = this.account.name || this.account.user;

    const intervalSec = Math.max(300, parseInt(this.account.keepaliveInterval) || 600); // 默认 10 分钟一次
    this.appendLog('CAG', `[${accName}] 移动云电脑持久保活守护看门狗已启动 (周期: ${Math.round(intervalSec / 60)} 分钟)...`, 'info', accName, 'ydpc');

    const runCycle = async () => {
      if (!this.workerRunning) return;
      try {
        await this.refreshVms();
        const vms = this.account.vms || [];

        const anyRunning = vms.some(v => String(v.vmStatus || '').includes('运行') || v.vmStatusCode === 1);
        if (!anyRunning) {
          this.metrics.status = 'offline';
          if (this.account.stats) this.account.stats.keepAliveStatus = 'offline';
          this.metrics.lastHeartbeatResult = '云电脑处于已关机状态，自动守护待命中';
        }

        for (const vm of vms) {
          if (vm.keepaliveEnabled !== false) {
            const isVmOff = String(vm.vmStatus || '').includes('关机') || vm.vmStatusCode === 23 || vm.vmStatusCode === 16;
            
            // 1. 判断是否为独立子账号 (子账号无权通过 API 自主开机，必须避免循环重试)
            const isSubAccount = this.account.accountType === 'sub';

            // 2. 判断是否为限时套餐且时长已耗尽 (如 20小时到期/剩余0小时/负数/月包用尽)
            const isLimitedExpired = (
              vm.durationMode === 'limited' && (
                vm.remainHours <= 0 || 
                (typeof vm.remainDurationTime === 'number' && vm.remainDurationTime <= 0) ||
                String(vm.remainText || '').includes('0小时') ||
                String(vm.remainText || '').includes('已耗尽')
              )
            ) || (
              (String(vm.skuName || '').includes('20小时') || String(vm.vmName || '').includes('20小时') || String(vm.skuName || '').includes('月包')) &&
              (vm.remainHours <= 0 || (typeof vm.remainDurationTime === 'number' && vm.remainDurationTime <= 0) || String(vm.remainText || '').includes('0小时'))
            );

            // 3. 自动开机守护逻辑 (加入全量熔断与状态抑制)
            if (this.account.features?.autoBoot && isVmOff) {
              if (isLimitedExpired) {
                if (!vm._hasWarnedExpired) {
                  this.appendLog('SOHO', `[${accName}][${vm.vmName}] 检测到机器已关机，由于限时套餐时长已耗尽 (${vm.remainText || '0小时'})，已智能跳过自动开机守护`, 'info', accName, 'ydpc');
                  vm._hasWarnedExpired = true;
                }
              } else if (isSubAccount || vm._bootRestricted) {
                if (!vm._hasWarnedSub) {
                  this.appendLog('SOHO', `[${accName}][${vm.vmName}] 检测到机器已关机，独立子账号受平台权限限制无法接口拉起，已进入被动守护待命模式`, 'info', accName, 'ydpc');
                  vm._hasWarnedSub = true;
                }
              } else {
                this.appendLog('SOHO', `[${accName}][${vm.vmName}] 检测到机器已关机，触发【自动开机守护】拉起中...`, 'warning', accName, 'ydpc');
                await this.bootVm(vm.userServiceId).catch(err => {
                  this.appendLog('SOHO', `[${accName}][${vm.vmName}] 自动开机未成功: ${err.message}`, 'warning', accName, 'ydpc');
                  if (err.message?.includes('子账号受限') || err.message?.includes('无权访问') || err.message?.includes('4141')) {
                    vm._bootRestricted = true;
                  }
                });
              }
            }

            // 4. 发送 SOHO 心跳 (仅在机器开启时或进行 SOHO 保活)
            if (this.account.features?.sohoHeartbeat !== false) {
              await this.sendHeartbeat(vm.userServiceId).catch(() => {});
            }

            // 5. 执行 CAG TCP 握手保活 (仅在机器运行时有效握手)
            if (this.account.features?.cagKeepAlive !== false && !isVmOff) {
              await this.pingCag(vm.userServiceId, 3).catch(e => {
                this.appendLog('CAG', `[${accName}][${vm.vmName}] CAG 握手异常: ${e.message}`, 'warning', accName, 'ydpc');
              });
            }
          }
        }
      } catch (err) {
        this.metrics.status = 'offline';
        this.metrics.lastHeartbeatResult = `异常: ${err.message}`;
        this.appendLog('CAG', `[${accName}] 移动云保活巡检异常: ${err.message}`, 'error', accName, 'ydpc');
      }

      if (this.workerRunning) {
        this.loopTimer = setTimeout(runCycle, intervalSec * 1000);
      }
    };

    // 延迟 3 秒立即执行第一次
    setTimeout(runCycle, 3000);
  }

  stopKeepAliveWorker() {
    this.workerRunning = false;
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    this.metrics.status = 'offline';
    if (this.account.stats) this.account.stats.keepAliveStatus = 'offline';
  }
}

module.exports = { YdpcClient };
