const crypto = require('crypto');

const PRESET_MESSAGES = [
  '今天北京天气怎么样？（请用一句话回答）',
  '给我讲一个冷笑话。（简短回答）',
  '来一首唐诗。（简短回答）',
  '空腹可以吃饭吗？（幽默简短回答）',
  '推荐一部经典的科幻电影。（简明扼要）',
  '人工智能未来发展趋势是什么？（简明扼要）',
  '怎样保持良好的身心健康？（简短回答）',
  '请用一句话分享今天的正能量心情。'
];

function md5(t) {
  return crypto.createHash('md5').update(t).digest('hex').toLowerCase();
}

function sha256(t) {
  return crypto.createHash('sha256').update(t).digest('hex').toLowerCase();
}

/**
 * 纯原生毫秒级 HTTP 协议直连执行天翼 AI 对话任务 (彻底剔除 Chromium/Puppeteer)
 */
async function executeNativeAiChat(client, acc, onLog = console.log) {
  onLog('AIChat', `正在获取 AI 对话安全网关与 SSO 公钥配置...`, 'info');
  
  // 1. 获取网关信息并解密 SSO 公钥
  const sysRes = await fetch('https://gwyilian.ctyun.cn/server/eaiSysInfo');
  const sysJson = await sysRes.json();
  const rawSys = (sysJson.data || '').replace(/[\r\n]/g, '');
  const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from('chinatelecom@cnn', 'utf8'), null);
  let dec = decipher.update(rawSys, 'base64', 'utf8');
  dec += decipher.final('utf8');
  const gatewayInfo = JSON.parse(dec);
  const ssopk = gatewayInfo.sso?.ssopk;
  const ssopkid = gatewayInfo.sso?.ssopkid;

  if (!ssopk) {
    throw new Error('未能从网关提取到有效的 SSO RSA 公钥配置');
  }

  // 2. 确保客户端登录并获取 CAS Service Ticket
  if (!client.loginInfo) {
    onLog('AIChat', `正在刷新天翼云客户端认证会话...`, 'info');
    const loginRes = await client.login();
    if (!loginRes.success) throw new Error(loginRes.error || '登录失败');
  }

  onLog('AIChat', `请求天翼 CAS 单点登录 Ticket 票据...`, 'info');
  const nowTs = Date.now().toString();
  const authData = client.loginInfo;
  const sigStr = `${client.deviceType}${nowTs}${authData.tenantId}${nowTs}${authData.userId}103020001${authData.secretKey}`;
  const service = 'https://eaichat.ctyun.cn:443/chat/#/aichat';

  const ticketRes = await (await fetch(`https://desk.ctyun.cn:8810/api/auth/client/getTicket?service=${encodeURIComponent(service)}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0',
      'ctg-devicetype': client.deviceType,
      'ctg-version': '103020001',
      'ctg-devicecode': acc.deviceCode,
      'ctg-userid': String(authData.userId),
      'ctg-tenantid': String(authData.tenantId),
      'ctg-timestamp': nowTs,
      'ctg-requestid': nowTs,
      'ctg-signaturestr': md5(sigStr),
      'Referer': 'https://pc.ctyun.cn/'
    }
  })).json();

  if (!ticketRes.data || !ticketRes.data.ticket) {
    throw new Error('获取 CAS Ticket 失败: ' + (ticketRes.msg || JSON.stringify(ticketRes)));
  }
  const ticket = ticketRes.data.ticket;

  // 3. 生成 16 字节随机密钥并使用 RSA-PKCS1 加密
  onLog('AIChat', `RSA-PKCS1 加密生成客户端鉴权凭据，换取对话会话密钥 (SessionKey)...`, 'info');
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let clientKey = '';
  for (let i = 0; i < 16; i++) clientKey += chars[Math.floor(Math.random() * chars.length)];
  const pem = `-----BEGIN PUBLIC KEY-----\n${ssopk}\n-----END PUBLIC KEY-----`;
  const encClientKey = crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(clientKey, 'utf8')).toString('hex');

  const authParams = new URLSearchParams();
  authParams.append('loginType', 'iamTicket');
  authParams.append('clientId', 'eaiapp');
  authParams.append('iamTicket', ticket);
  authParams.append('redirectUri', service);
  authParams.append('clientKey', encClientKey);
  authParams.append('clientKeyId', ssopkid);

  const authPostRes = await fetch('https://eaichat.ctyun.cn/sso/login/v2/iam/ticketAuthorize', {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0',
      'Referer': 'https://eaichat.ctyun.cn/chat/',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: authParams.toString()
  });

  const authJson = await authPostRes.json();
  if (authJson.resultCode !== 0 || !authJson.data?.sessionKey) {
    throw new Error('SSO Ticket 鉴权换取失败: ' + (authJson.resultMsg || JSON.stringify(authJson)));
  }

  const rawCookies = authPostRes.headers.get('set-cookie') || '';
  const ylTokenMatch = rawCookies.match(/YL-Token=([^;]+)/);
  const ylSsidMatch = rawCookies.match(/YL-Ssid=([^;]+)/);
  const ylToken = ylTokenMatch ? ylTokenMatch[1] : (authPostRes.headers.get('yl-authorization') || '');
  const ylSsid = ylSsidMatch ? ylSsidMatch[1] : '';
  const cookieHeader = `YL-Token=${ylToken}; YL-Ssid=${ylSsid}`;

  const decipherSk = crypto.createDecipheriv('aes-128-ecb', Buffer.from(clientKey, 'utf8'), null);
  let sk = decipherSk.update(authJson.data.sessionKey, 'base64', 'utf8');
  sk += decipherSk.final('utf8');

  // 4. 发送 AI 对话请求
  const prompt = PRESET_MESSAGES[Math.floor(Math.random() * PRESET_MESSAGES.length)];
  onLog('AIChat', `向天翼云智助手发送对话指令: "${prompt}"...`, 'info');

  const chatBody = {
    key_model: 'telechat',
    messages: [
      { role: 'user', content: prompt }
    ],
    stream: false,
    client_retry: true,
    web_search: false
  };

  const bodyJsonStr = JSON.stringify(chatBody);
  const dataMd5 = md5(bodyJsonStr);
  const ts = Date.now().toString();
  let rnd = '';
  for (let i = 0; i < 8; i++) rnd += chars[Math.floor(Math.random() * chars.length)];
  const rawSign = `${dataMd5}&${sk}&${ts}&${rnd}`;
  const webSign = sha256(rawSign);
  const traceId = crypto.randomUUID();

  const chatRes = await fetch('https://eaichat.ctyun.cn/ai/portal/v3/openai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookieHeader,
      'YL-Authorization': ylToken,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0',
      'Referer': 'https://eaichat.ctyun.cn/chat/',
      'Origin': 'https://eaichat.ctyun.cn',
      'x-client-trace-id': traceId,
      'x-eai-source': 'web-eai',
      'x-eai-version': '202060305',
      'YL-Main-Version': '202060305',
      'YL-Product-Id': '5',
      'Web-Signature': webSign,
      'Web-Random': rnd,
      'Web-Timestamp': ts
    },
    body: bodyJsonStr
  });

  if (!chatRes.ok) {
    throw new Error(`AI 对话接口异常 (HTTP ${chatRes.status})`);
  }

  const resText = await chatRes.text();
  onLog('AIChat', `✅ AI 对话成功完成！已获取今日 100 积分！`, 'success');
  
  await client.refreshOfficialTasks();
  return { success: true, message: 'AI 对话成功完成，积分已刷新' };
}

/**
 * 登录打卡
 */
async function executeNativeSign(client, acc, onLog = console.log) {
  onLog('Sign', `正在执行登录打卡认证...`, 'info');
  try {
    const res = await client.login();
    if (!res.success) throw new Error(res.error || '登录握手失败');
    await client.getDesktops();

    // 确保长连接握手通道激活并发送 Type 112 登录凭据包
    if (!client.wsAlive) {
      onLog('Sign', `正在激活云电脑握手通道...`, 'info');
      client.startKeepAliveWorker();
    }

    await new Promise(r => setTimeout(r, 2500));
    await client.refreshOfficialTasks();
    onLog('Sign', `✅ 登录打卡握手完成！已同步上报天翼云任务中心！`, 'success');
    return { success: true, message: '打卡成功，官方积分已刷新' };
  } catch (e) {
    onLog('Sign', `登录打卡异常: ${e.message}`, 'error');
    throw e;
  }
}

/**
 * 云电脑挂机守护
 */
async function executeNativeHang(client, acc, onLog = console.log) {
  onLog('Hang', `正在检查云电脑 WebSocket 长连接保活状态...`, 'info');
  try {
    // 确保后台长连接守护进程正在运行
    if (!client.workerRunning && acc.features?.keepAlive !== false && !acc.manualShutdown) {
      onLog('Hang', `正在启动云电脑长连接守护进程...`, 'info');
      client.startKeepAliveWorker();
    }
    await client.refreshOfficialTasks();
    const hangTask = client.metrics.officialTasks?.find(t => t.name.includes('使用1小时'));
    const curSec = hangTask ? (hangTask.current || 0) : 0;
    const totSec = hangTask ? (hangTask.total || 3600) : 3600;
    const curMin = Math.floor(curSec / 60);
    const totMin = Math.floor(totSec / 60);

    if (curSec >= totSec || (hangTask && hangTask.status === 2)) {
      onLog('Hang', `✅ 今日云电脑使用时长已达标 (${totMin}分钟)，已斩获 100 积分奖励！`, 'success');
      return { success: true, isCompleted: true, message: `今日云电脑使用时长已满 ${totMin} 分钟，已斩获 100 积分！` };
    } else {
      onLog('Hang', `⚡ 当前挂机进度: ${curMin}/${totMin} 分钟 (${curSec}/${totSec}秒)。长连接正稳定运行累加中。`, 'info');
      return { success: true, isCompleted: false, message: `当前挂机进度: ${curMin}/${totMin} 分钟，持续累加中` };
    }
  } catch (e) {
    onLog('Hang', `挂机守护异常: ${e.message}`, 'error');
    throw e;
  }
}

module.exports = {
  executeNativeAiChat,
  executeNativeSign,
  executeNativeHang
};
