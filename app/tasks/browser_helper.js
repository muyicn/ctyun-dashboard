const fs = require('fs');

function getBrowserPath() {
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  }
  // Linux / Docker 容器环境
  const linuxCandidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  for (const p of linuxCandidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'chromium';
}

module.exports = { getBrowserPath };
