const crypto = require('crypto');
const https = require('https');

const APP_KEY = 'ef80482854c2a2a36311a46011f3303f144bdf69b4b4223cf916f4c7f0f55135';
const APP_SECRET_HEX = 'cd58cf413dc43b07993f82f532b0f8e83d259d3ae2305de76811ccd1303853f7';
const APP_SECRET = Buffer.from(APP_SECRET_HEX, 'hex');

const BASE_URL = 'https://soho.komect.com';
const VERSION = '2.18.21';
const VERSION_NUM = '2182100';

const HEADER_ORDER = [
  'X-SOHO-AppKey',
  'X-SOHO-AppType',
  'X-SOHO-ClientVersion',
  'X-SOHO-DeviceId',
  'X-SOHO-RomVersion',
  'X-SOHO-SohoToken',
  'X-SOHO-Timestamp',
  'X-SOHO-UserId',
  'X-SOHO-Uuid',
  'X-SOHO-VersionNum'
];

function genUuid() {
  const chars = '0123456789ABCDEF';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  s = s.substring(0, 12) + '4' + s.substring(13, 16) + (chars.charAt((parseInt(s.charAt(16), 16) & 0x3) | 0x8)) + s.substring(17);
  return 'uuid_' + s;
}

function nowMs() {
  return Date.now().toString();
}

function genDeviceId() {
  const sn = genUuid().replace('uuid_', '').substring(0, 11).toUpperCase();
  const mac = Array.from({ length: 6 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join(':');
  return `${sn}-${mac}`;
}

/**
 * 手算 RSA NoPadding 分块加密 (左侧 0 填充到 128 字节, c = m^e mod n)
 */
function rsaNoPaddingEncryptBlock(publicKeyPem, blockBuf) {
  if (blockBuf.length > 128) throw new Error('RSA block too long');
  const padded = Buffer.alloc(128, 0);
  blockBuf.copy(padded, 128 - blockBuf.length);

  try {
    return crypto.publicEncrypt({
      key: publicKeyPem,
      padding: crypto.constants.RSA_NO_PADDING
    }, padded);
  } catch (e) {
    // 兼容回退：如果底层 OpenSSL 限制，使用 BigInt 手算 m^e mod n
    const keyObj = crypto.createPublicKey(publicKeyPem);
    const jwk = keyObj.export({ format: 'jwk' });
    const nBuf = Buffer.from(jwk.n, 'base64url');
    const eBuf = Buffer.from(jwk.e, 'base64url');
    const n = BigInt('0x' + nBuf.toString('hex'));
    const exp = BigInt('0x' + eBuf.toString('hex'));
    const m = BigInt('0x' + padded.toString('hex'));
    
    // 模幂运算
    let result = 1n;
    let base = m % n;
    let exponent = exp;
    while (exponent > 0n) {
      if (exponent % 2n === 1n) result = (result * base) % n;
      base = (base * base) % n;
      exponent /= 2n;
    }
    const hex = result.toString(16).padStart(256, '0');
    return Buffer.from(hex, 'hex');
  }
}

function rsaEncryptBody(publicKeyPem, plainBuf) {
  const blocks = [];
  for (let i = 0; i < plainBuf.length || (i === 0 && plainBuf.length === 0); i += 117) {
    const chunk = plainBuf.subarray(i, i + 117);
    if (chunk.length === 0 && i > 0) break;
    blocks.push(rsaNoPaddingEncryptBlock(publicKeyPem, chunk));
  }
  return Buffer.concat(blocks).toString('base64');
}

function rsaEncryptPassword(publicKeyPem, password) {
  const block = Buffer.from(password, 'utf8');
  return rsaNoPaddingEncryptBlock(publicKeyPem, block).toString('base64');
}

function buildSign(method, path, headers, bodyPayload) {
  const parts = [];
  for (const k of HEADER_ORDER) {
    const v = headers[k] || '';
    if (v) parts.push(`${k}=${v}`);
  }
  let signSrc = `${method}&${path}&${parts.join('&')}`;
  if (bodyPayload) {
    signSrc += `&body=${bodyPayload}`;
  }
  return crypto.createHmac('sha256', APP_SECRET).update(signSrc, 'utf8').digest('hex');
}

class SohoClient {
  constructor(options = {}) {
    this.deviceId = options.deviceId || genDeviceId();
    this.userId = options.userId || '';
    this.sohoToken = options.sohoToken || '';
    this.publicKeyPem = options.publicKeyPem || null;
    this.accountType = options.accountType || 'main'; // 'main' (和家亲主号) | 'sub' (独立子号)
    this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

    const platShort = 'windows';
    const release = '10.0.19045';
    const model = 'x64';
    this.appType = `${platShort}|${release}|${model}|0|-1|${this.deviceId}|`;
    this.romVersion = `-${release}`;
  }

  async fetchApi(path, data = null, method = 'POST', isRetry = false) {
    let bodyPayload = null;
    let sendBody = null;

    if (data !== null) {
      if (!this.publicKeyPem) {
        await this.bootstrapPublicKey();
      }
      const plain = Buffer.from(JSON.stringify(data), 'utf8');
      bodyPayload = rsaEncryptBody(this.publicKeyPem, plain);
      sendBody = JSON.stringify({ data: bodyPayload });
    }

    const headers = {
      'X-SOHO-AppKey': APP_KEY,
      'X-SOHO-AppType': this.appType,
      'X-SOHO-ClientVersion': VERSION,
      'X-SOHO-DeviceId': this.deviceId,
      'X-SOHO-RomVersion': this.romVersion,
      'X-SOHO-SohoToken': this.sohoToken || '',
      'X-SOHO-Timestamp': nowMs(),
      'X-SOHO-UserId': this.userId || '',
      'X-SOHO-Uuid': genUuid(),
      'X-SOHO-VersionNum': VERSION_NUM,
      'Content-Type': 'application/json',
      'User-Agent': this.userAgent
    };

    headers['X-SOHO-Signature'] = buildSign(method, path, headers, bodyPayload);

    // 过滤掉空值字段
    const outgoingHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      if (v !== '') outgoingHeaders[k] = v;
    }

    const url = `${BASE_URL}/terminal${path}`;
    const res = await fetch(url, {
      method,
      headers: outgoingHeaders,
      body: sendBody
    });

    const rawText = await res.text();
    let result;
    try {
      result = JSON.parse(rawText);
    } catch (e) {
      throw new Error(`移动云网关响应异常 (HTTP ${res.status})`);
    }

    // 自动重登机制：若 SOHO 判定 token 过期或用户未登录 (如 code 4001, 4003, 1000100)
    if (!isRetry && (result.code === 4001 || result.code === 4003 || result.msg?.includes('未登录') || result.msg?.includes('已失效'))) {
      if (this.savedUsername && this.savedPassword) {
        await this.login(this.savedUsername, this.savedPassword, this.accountType);
        return await this.fetchApi(path, data, method, true);
      }
    }

    return result;
  }

  async bootstrapPublicKey() {
    const path = '/login/encryptKey/v1';
    const headers = {
      'X-SOHO-AppKey': APP_KEY,
      'X-SOHO-AppType': this.appType,
      'X-SOHO-ClientVersion': VERSION,
      'X-SOHO-DeviceId': this.deviceId,
      'X-SOHO-RomVersion': this.romVersion,
      'X-SOHO-SohoToken': '',
      'X-SOHO-Timestamp': nowMs(),
      'X-SOHO-UserId': '',
      'X-SOHO-Uuid': genUuid(),
      'X-SOHO-VersionNum': VERSION_NUM,
      'Content-Type': 'application/json',
      'User-Agent': this.userAgent
    };
    headers['X-SOHO-Signature'] = buildSign('POST', path, headers, null);

    const outgoingHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      if (v !== '') outgoingHeaders[k] = v;
    }

    const res = await fetch(`${BASE_URL}/terminal${path}`, {
      method: 'POST',
      headers: outgoingHeaders,
      body: null
    });

    const rawText = await res.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      throw new Error(`SOHO 网关响应异常 (HTTP ${res.status})`);
    }

    if (data.code !== 2000 || !data.data) {
      throw new Error(`SOHO bootstrap publicKey 失败: ${data.msg || JSON.stringify(data)}`);
    }

    this.publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${data.data}\n-----END PUBLIC KEY-----`;
    return this.publicKeyPem;
  }

  async getLoginPublicKey() {
    const res = await this.fetchApi('/login/publicKey/v1', { type: 1 });
    if (res.code !== 2000 || !res.data) {
      throw new Error(`获取登录公钥失败: ${res.msg || JSON.stringify(res)}`);
    }
    return `-----BEGIN PUBLIC KEY-----\n${res.data}\n-----END PUBLIC KEY-----`;
  }

  async login(username, password, accountType = 'main') {
    this.savedUsername = username;
    this.savedPassword = password;
    this.accountType = accountType;
    await this.bootstrapPublicKey();
    const loginPk = await this.getLoginPublicKey();
    const encPwd = rsaEncryptPassword(loginPk, password);

    // 1. 如果用户显式指定为子账号，直接调用 SOHO 独立子账号接口 (参数为 subAccount)
    if (accountType === 'sub') {
      const subRes = await this.fetchApi('/login/home/namePwdLogin/v1', {
        subAccount: username,
        password: encPwd,
        verificationCode: '',
        randomCode: ''
      });
      if (subRes.code === 2000 && subRes.data) {
        this.userId = String(subRes.data.userId);
        this.sohoToken = subRes.data.sohoToken;
        this.accountType = 'sub';
        return { success: true, userId: this.userId, sohoToken: this.sohoToken, accountType: 'sub', raw: subRes.data };
      }
      throw new Error(subRes.msg || `子账号登录失败 (code ${subRes.code})`);
    }

    // 2. 主账号模式：先尝试主账号接口，若失败自动智能回退尝试子账号接口
    const mainRes = await this.fetchApi('/login/namePwdLogin/v1', {
      username,
      password: encPwd,
      verificationCode: '',
      randomCode: ''
    });

    if (mainRes.code === 2000 && mainRes.data) {
      this.userId = String(mainRes.data.userId);
      this.sohoToken = mainRes.data.sohoToken;
      this.accountType = 'main';
      return { success: true, userId: this.userId, sohoToken: this.sohoToken, accountType: 'main', raw: mainRes.data };
    }

    // 智能回退尝试子账号
    try {
      const subFallback = await this.fetchApi('/login/home/namePwdLogin/v1', {
        subAccount: username,
        password: encPwd,
        verificationCode: '',
        randomCode: ''
      });
      if (subFallback.code === 2000 && subFallback.data) {
        this.userId = String(subFallback.data.userId);
        this.sohoToken = subFallback.data.sohoToken;
        this.accountType = 'sub';
        return { success: true, userId: this.userId, sohoToken: this.sohoToken, accountType: 'sub', raw: subFallback.data };
      }
    } catch (e) {}

    throw new Error(mainRes.msg || `移动云登录失败 (code ${mainRes.code})`);
  }

  async listCloudPcs() {
    const res = await this.fetchApi('/cc/cloudPc/list/v6', { pageNum: 1 });
    if (res.code !== 2000 || !res.data) {
      throw new Error(res.msg || `获取移动云电脑列表失败 (code ${res.code})`);
    }

    const list = res.data.list || [];
    return list.map(vm => {
      // 提取状态文字 (优先使用官方显示的 vmStatusShow)
      let vmStatusText = vm.vmStatusShow ? String(vm.vmStatusShow) : '';
      if (!vmStatusText) {
        const statusCode = Number(vm.vmStatus);
        if (statusCode === 1) vmStatusText = '运行中';
        else if (statusCode === 23 || statusCode === 16) vmStatusText = '已关机';
        else if (statusCode === 0) vmStatusText = '未开机';
        else vmStatusText = vm.vmStatus !== undefined && vm.vmStatus !== null ? `状态(${vm.vmStatus})` : '未知';
      }

      // 提取与格式化限时与永久时长
      const rawRemain = vm.remainDurationTime;
      let durationMode = 'permanent';
      let remainHours = 0;
      let remainText = '♾️ 永久使用';

      if (rawRemain !== null && rawRemain !== undefined && rawRemain !== '' && String(rawRemain) !== 'None') {
        const sec = parseInt(rawRemain, 10);
        if (!isNaN(sec)) {
          durationMode = 'limited';
          remainHours = Math.round((sec / 3600) * 10) / 10;
          if (sec <= 0) {
            remainText = '⏱️ 0小时';
          } else {
            remainText = `⏱️ 剩余 ${remainHours} 小时`;
          }
        }
      }

      return {
        userServiceId: vm.userServiceId,
        vmName: vm.vmName || '中国移动云电脑',
        vmStatus: vmStatusText,
        vmStatusCode: vm.vmStatus,
        spuCode: vm.spuCode || '',
        skuName: vm.skuName || '',
        cpu: vm.cpu || '',
        memory: vm.memory || '',
        expireAt: vm.expireTime || vm.expireAt || '',
        durationMode,
        remainHours,
        remainText,
        rawRemainDuration: rawRemain,
        raw: vm
      };
    });
  }

  async getFirmAuth(userServiceId) {
    const res = await this.fetchApi('/cc/getFirmAuth/v1', { userServiceId: Number(userServiceId) });
    if (res.code !== 2000 || !res.data) {
      throw new Error(res.msg || `获取底层 CAG 凭据失败: ${res.msg}`);
    }
    return res.data;
  }

  async heartbeat(userServiceId) {
    return await this.fetchApi('/cc/cloudPc/heartbeat/v2', { userServiceId: Number(userServiceId) });
  }

  async bootVm(userServiceId) {
    // 官方 SOHO 开机/激活接口
    try {
      const res = await this.fetchApi('/cc/activate/v1', { userServiceId: Number(userServiceId) });
      if (res && (res.code === 2000 || res.code === 0)) {
        return { success: true, message: '开机/激活指令已生效' };
      }
      if (res && (res.errMsg || res.msg)) {
        throw new Error(res.errMsg || res.msg);
      }
      throw new Error(`开机请求被拒绝 (code ${res?.code})`);
    } catch (e) {
      throw new Error(e.message || '开机指令下发失败');
    }
  }

  async rebootVm(userServiceId) {
    try {
      const res = await this.fetchApi('/cc/getRebootAuth/v1', { userServiceId: Number(userServiceId) });
      if (res && (res.code === 2000 || res.code === 0)) {
        return { success: true, message: '重启指令已成功下达！' };
      }
      if (res && (res.errMsg || res.msg)) {
        throw new Error(res.errMsg || res.msg);
      }
      throw new Error(`重启请求被拒绝 (code ${res?.code})`);
    } catch (e) {
      throw new Error(e.message || '重启指令下发失败');
    }
  }

  async shutdownVm(userServiceId) {
    try {
      const res = await this.fetchApi('/cc/cloudPc/logout/v2', { userServiceId: Number(userServiceId) });
      if (res && (res.code === 2000 || res.code === 0)) {
        return { success: true, message: '关机/断开指令已生效！' };
      }
      if (res && (res.errMsg || res.msg)) {
        throw new Error(res.errMsg || res.msg);
      }
      throw new Error(`关机请求被拒绝 (code ${res?.code})`);
    } catch (e) {
      throw new Error(e.message || '关机指令下发失败');
    }
  }
}

module.exports = {
  SohoClient,
  genUuid,
  nowMs,
  genDeviceId,
  buildSign,
  rsaEncryptBody,
  rsaEncryptPassword
};
