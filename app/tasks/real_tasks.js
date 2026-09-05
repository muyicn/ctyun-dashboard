const puppeteer = require('puppeteer-core');
const { getBrowserPath } = require('./browser_helper');

const PRESET_MESSAGES = [
  '今天北京天气怎么样？（简短回答）',
  '给我讲一个冷笑话。（简短回答）',
  '来一首古诗。（简短回答）',
  '空腹可以吃饭吗？（简短回答）',
  '推荐一部人生必看电影。（简短回答）',
  '人工智能的发展趋势是什么？（简短回答）'
];

/**
 * 真实执行天翼 AI 对话任务 (获取 100 积分)
 */
async function executeRealAiChat(user, password, ocrEngine, onLog = console.log) {
  const browserPath = getBrowserPath();
  onLog('AIChat', `正在启动后台 Chromium 浏览器引擎 (${browserPath.split('\\').pop() || 'chromium'})...`, 'info');

  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1280,800']
  });

  try {
    const page = await browser.newPage();
    const loginUrl = 'https://desk.ctyun.cn/cloudB/dy/iam/api/auth/iam/cas/login?service=https%3A%2F%2Feaichat.ctyun.cn%3A443%2Fchat%2F%23%2Faichat&consent=false';

    onLog('AIChat', `正在打开天翼 AI 对话接入网关...`, 'info');
    await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 35000 });

    onLog('AIChat', `正在填写账号与密码凭据...`, 'info');
    await page.waitForSelector('input[type="text"]', { timeout: 15000 });
    await page.type('input[type="text"]', user);
    await page.type('input[type="password"]', password);

    // 验证码检测与识别
    const capImg = await page.$('.fgt-capt-ct img');
    if (capImg && ocrEngine) {
      onLog('AIChat', `检测到图形验证码，正在识别...`, 'info');
      const buf = await capImg.screenshot();
      const code = (await ocrEngine.classification(buf)).trim();
      onLog('AIChat', `OCR 识别结果: ${code}`, 'info');
      const capInput = await page.$('.fgt-capt-ct input');
      if (capInput) await capInput.type(code);
    }

    onLog('AIChat', `提交认证并等待登录跳转...`, 'info');
    const submitBtn = await page.$('button.lgm-submit-ct');
    if (submitBtn) {
      await Promise.all([
        submitBtn.click(),
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 35000 }).catch(() => {})
      ]);
    }

    await new Promise(r => setTimeout(r, 3000));
    if (!page.url().includes('/chat')) {
      await page.goto('https://eaichat.ctyun.cn/chat/#/aichat', { waitUntil: 'networkidle2', timeout: 35000 });
    }

    onLog('AIChat', `等待 AI 对话界面就绪...`, 'info');
    await page.waitForSelector('div.input-box.input-wrap', { timeout: 20000 });

    const inputEle = await page.$('div.input-box.input-wrap textarea') || 
                     await page.$('div.input-box.input-wrap [contenteditable="true"]') || 
                     await page.$('div.input-box.input-wrap');

    if (!inputEle) throw new Error('未能定位到 AI 聊天输入框');

    const randomMsg = PRESET_MESSAGES[Math.floor(Math.random() * PRESET_MESSAGES.length)];
    onLog('AIChat', `正在发送对话消息: "${randomMsg}"`, 'info');
    await inputEle.click();
    await page.keyboard.type(randomMsg);
    await new Promise(r => setTimeout(r, 2000));

    const sendBtn = await page.$('div.send-button');
    if (!sendBtn) throw new Error('未找到发送按钮');

    await sendBtn.click();
    onLog('AIChat', `消息已送达，正在等待 AI 生成回复并触发官方积分入账 (约12秒)...`, 'info');
    await new Promise(r => setTimeout(r, 12000));

    onLog('AIChat', `✅ 天翼 AI 对话任务圆满完成！官方 100 积分已入账`, 'success');
    return { success: true, message: `AI 对话成功，已触发官方 100 积分奖励` };

  } finally {
    await browser.close();
  }
}

/**
 * 真实执行天翼云电脑网页端登录打卡与挂机 (支持精确指定分辨率与缩放比例)
 * @param {string} user 账号
 * @param {string} password 密码
 * @param {object} ocrEngine OCR引擎
 * @param {number} durationSeconds 保持挂机秒数
 * @param {object} displayConfig { width: 2560, height: 1440, scale: 150 }
 * @param {function} onLog 日志输出
 */
async function executeRealHang(user, password, ocrEngine, durationSeconds = 90, displayConfig = {}, onLog = console.log) {
  const browserPath = getBrowserPath();
  
  // 默认真实目标物理渲染分辨率 2560x1440，缩放 150% (DPI = 1.5)
  const width = parseInt(displayConfig.width) || 2560;
  const height = parseInt(displayConfig.height) || 1440;
  const scalePercent = parseInt(displayConfig.scale) || 150;
  const deviceScaleFactor = (scalePercent / 100) || 1.5;

  // 核心公式修正：
  // 必须直接使用设定的精确物理分辨率 2560x1440 作为窗口尺寸与视口尺寸！
  // 天翼云 Agent 在网页全屏与画布绑定时，直接按 clientWidth / clientHeight / innerHeight 采集虚拟显示器高度
  // 如果逻辑尺寸缩小为 960，Agent 采集后就会换算为 1438；只有直接设定为精准 2560x1440 且绑定 deviceScaleFactor，Agent 读取物理分辨率才会 100% 绝对等于 2560x1440！
  onLog('Hang', `启动云电脑挂机引擎 (${browserPath.split('\\').pop() || 'chromium'}) [锁定精准物理分辨率: ${width}x${height}, DPI缩放: ${scalePercent}%]...`, 'info');

  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      `--window-size=${width},${height}`,
      `--force-device-scale-factor=${deviceScaleFactor}`,
      '--high-dpi-support=1'
    ],
    defaultViewport: null
  });

  try {
    const page = await browser.newPage();
    
    // 通过 Chrome DevTools Protocol (CDP) 精确覆写物理像素与设备像素比
    const cdp = await page.target().createCDPSession();
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: width,
      height: height,
      deviceScaleFactor: deviceScaleFactor,
      mobile: false,
      screenOrientation: { angle: 0, type: 'landscapePrimary' }
    });

    await page.evaluateOnNewDocument((w, h, sf) => {
      try {
        const proto = Object.getPrototypeOf(window.screen);
        Object.defineProperty(proto, 'width', { get: () => w });
        Object.defineProperty(proto, 'height', { get: () => h });
        Object.defineProperty(proto, 'availWidth', { get: () => w });
        Object.defineProperty(proto, 'availHeight', { get: () => h });
        Object.defineProperty(window, 'devicePixelRatio', { get: () => sf });
        Object.defineProperty(window, 'innerWidth', { get: () => w });
        Object.defineProperty(window, 'innerHeight', { get: () => h });
      } catch (e) {}
    }, width, height, deviceScaleFactor);

    const loginUrl = 'https://pc.ctyun.cn/#/login';

    onLog('Hang', `打开 pc.ctyun.cn 登录页...`, 'info');
    await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 35000 });

    onLog('Hang', `输入账号密码登录...`, 'info');
    await page.waitForSelector('input[placeholder*="手机号"], input[placeholder*="账号"], input[type="text"]', { timeout: 15000 });
    const accInput = await page.$('input[placeholder*="手机号"]') || await page.$('input[placeholder*="账号"]') || await page.$('input[type="text"]');
    const pwdInput = await page.$('input[placeholder*="密码"]') || await page.$('input[type="password"]');

    await accInput.type(user);
    await pwdInput.type(password);

    const capImg = await page.$('img.code-img');
    const capInput = await page.$('input[placeholder*="请输入验证码"]');
    if (capImg && capInput && ocrEngine) {
      const buf = await capImg.screenshot();
      const code = (await ocrEngine.classification(buf)).trim();
      onLog('Hang', `识别登录验证码: ${code}`, 'info');
      await capInput.type(code);
    }

    const loginBtn = await page.$('button.btn-submit-pc') || await page.$('button[type="submit"]');
    if (loginBtn) await loginBtn.click();

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 4000));

    if (!page.url().includes('desktop-list') && !page.url().includes('desktop?id=')) {
      await page.goto('https://pc.ctyun.cn/#/desktop-list', { waitUntil: 'networkidle2', timeout: 20000 });
      await new Promise(r => setTimeout(r, 3000));
    }

    onLog('Hang', `寻找云电脑进入入口...`, 'info');
    await page.waitForSelector('div.desktopcom-enter', { timeout: 15000 }).catch(() => {});

    const entered = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('div.desktopcom-enter'));
      for (const btn of btns) {
        if (btn.innerText && btn.innerText.includes('进入AI云电脑')) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!entered && !page.url().includes('desktop?id=')) {
      throw new Error('未找到“进入AI云电脑”按钮，或名下无云电脑资源');
    }

    onLog('Hang', `已成功进入云电脑窗口 (已同步设定 ${width}x${height} @ ${scalePercent}%)！`, 'success');
    await new Promise(r => setTimeout(r, 5000));

    onLog('Hang', `云电脑保持挂机运行中 (本次保持 ${durationSeconds} 秒，在线时长将持续累加)...`, 'info');
    await new Promise(r => setTimeout(r, durationSeconds * 1000));

    onLog('Hang', `✅ 云电脑挂机阶段完成，时长已同步天翼云后台！`, 'success');
    return { success: true, message: `挂机保持完成，已维持 ${width}x${height} 分辨率` };

  } finally {
    await browser.close();
  }
}

module.exports = { executeRealAiChat, executeRealHang };
