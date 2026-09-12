/**
 * 移动云电脑 - 原生 SC/ZTE 自适应开机引擎 (完全还原原项目 keepalive_core.py)
 */

const crypto = require('crypto');
const https = require('https');

const SC_BASE_URL = 'https://api.soho.komect.com:1443';
const SC_CLIENT_ID = 'sc-user-5e38ece5';
const SC_RSA_PK_SDK2 = 
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDRwADvpa+s20CapaSeDeWAfRKbK5zD91jIUx' +
  'NDe/2twuvKdQA+Ln3VWFtL8opVod0ebqQanpVb/uITI56GcoVdSzis2IgqIkVvN+iOPH+on/F' +
  'K+6EXYeIZn3MYmVxsmS0IVifVl2EGLeOCRMwjPmy9fHB+gByQtGnxAsknwBKUqQIDAQAB';

const scTokenCache = new Map(); // vmId -> { token, expireAt }

function scRsaEncryptVmId(vmId) {
  const pem = `-----BEGIN PUBLIC KEY-----\n${SC_RSA_PK_SDK2}\n-----END PUBLIC KEY-----`;
  const encrypted = crypto.publicEncrypt({
    key: pem,
    padding: crypto.constants.RSA_PKCS1_PADDING
  }, Buffer.from(vmId, 'utf8'));
  return '{rsa}' + encrypted.toString('base64url');
}

function scHeaders(token = null, ct = 'application/json') {
  const h = {
    'gzs-client-id': SC_CLIENT_ID,
    'gzs-timestamp': Date.now().toString(),
    'sc-terminal-sn': 'keepalive-server',
    'sc-unit-type': 'Linux',
    'sc-network-type': '2',
    'User-Agent': 'cdpsdk-server-1.0',
    'Content-Type': ct
  };
  if (token) {
    h['Authorization'] = `Bearer ${token}`;
  }
  return h;
}

async function scGetToken(authData) {
  const vmId = String(authData.vmId);
  const bizCode = authData.bizCode || '10002';
  const scAuth = authData.scAuthCode;

  const now = Date.now();
  const cached = scTokenCache.get(vmId);
  if (cached && now < cached.expireAt) {
    return cached.token;
  }

  const agent = new https.Agent({ rejectUnauthorized: false });
  const form = new URLSearchParams({
    grant_type: 'ext',
    client_id: SC_CLIENT_ID,
    bizCode: String(bizCode),
    token: scAuth,
    source: 'biz'
  });

  const res = await fetch(`${SC_BASE_URL}/gzs/auth/oauth/token`, {
    method: 'POST',
    headers: scHeaders(null, 'application/x-www-form-urlencoded'),
    body: form.toString(),
    agent
  });

  const td = await res.json();
  const tokenData = td.data || td;
  if (!tokenData || !tokenData.access_token) {
    throw new Error(`SC OAuth 失败: ${td.message || td.code || JSON.stringify(td)}`);
  }

  const accessToken = tokenData.access_token;
  scTokenCache.set(vmId, { token: accessToken, expireAt: now + 240 * 1000 });
  return accessToken;
}

/**
 * SC 家庭云电脑开机: OAuth → getConnectInfo → getVmReadyStatus
 */
async function scBootVm(authData) {
  const vmId = String(authData.vmId);
  const accessToken = await scGetToken(authData);
  const encryptedVmId = scRsaEncryptVmId(vmId);
  const agent = new https.Agent({ rejectUnauthorized: false });

  // 1. getConnectInfo (触发开机)
  const ciRes = await fetch(`${SC_BASE_URL}/sc/open-portal/openapi/terminal/v1/getConnectInfo`, {
    method: 'POST',
    headers: scHeaders(accessToken),
    body: JSON.stringify({ vmId: encryptedVmId }),
    agent
  });

  const ci = await ciRes.json();
  if (ci.code !== '00000') {
    throw new Error(`getConnectInfo: ${ci.message || ci.code}`);
  }

  // 2. getVmReadyStatus
  const traceId = ci.data?.traceId || '';
  if (traceId) {
    const readyRes = await fetch(`${SC_BASE_URL}/sc/open-portal/openapi/terminal/v1/getVmReadyStatus`, {
      method: 'POST',
      headers: scHeaders(accessToken),
      body: JSON.stringify({ vmId: encryptedVmId, traceId }),
      agent
    });
    const rs = await readyRes.json();
    const ready = rs.data?.readyStatus;
    if (ready === 1) {
      return { success: true, message: '🎉 SC家庭云电脑开机成功 (ready=1)！' };
    }
    return { success: true, message: `SC开机指令已下发 (状态: ${ready || '启动中'})` };
  }

  return { success: true, message: 'SC云电脑开机已触发！' };
}

/**
 * 统一移动云开机路由调度 (完全对齐原项目 keepalive_core.py boot_vm 逻辑)
 * - 判断从未开机 (vmStatus=0)
 * - 判断已经在运行中 (status 运行中)
 * - SC 家庭云开机 (scAuthCode)
 * - ZTE 中兴政企云开机 / 状态提示 (cagIp / vmcIp)
 */
async function bootYdpcVmUnified(sohoClient, authData, userServiceId, vmInfo = {}) {
  const name = vmInfo.vmName || '移动云电脑';
  const vmStatus = vmInfo.vmStatus || vmInfo.vmStatusCode;
  const isRunning = String(vmInfo.vmStatus || '').includes('运行') || vmStatus === 1;

  // 1. 已在运行中判断
  if (isRunning) {
    return { success: true, message: `${name}: 已在运行中` };
  }

  // 2. 从未开机判断
  if ((vmStatus === 0 || vmStatus === '0') && !vmInfo.vmStatusShow) {
    throw new Error(`${name}: 从未开机，需先用官方客户端连接一次`);
  }

  const scAuth = authData?.scAuthCode;
  const cagIp = authData?.cagIp;

  // 3. SC 家庭云电脑分支 (包含 scAuthCode，无 cagIp)
  if (scAuth && !cagIp) {
    return await scBootVm(authData);
  }

  // 4. ZTE 中兴政企云电脑分支
  try {
    const res = await sohoClient.bootVm(userServiceId);
    return { success: true, message: res.message || `${name}: 开机指令已生效` };
  } catch (err) {
    const errMsg = err.message || '';
    if (errMsg.includes('无权访问') || errMsg.includes('4141')) {
      throw new Error(`子账号受限: 请在官方App连接一次即可激活保活`);
    }
    if (errMsg.includes('用完') || errMsg.includes('已用尽') || errMsg.includes('到期')) {
      throw new Error(`当前计费周期时长已用完`);
    }
    throw new Error(`开机未成功: ${errMsg}`);
  }
}

module.exports = {
  scBootVm,
  bootYdpcVmUnified
};
