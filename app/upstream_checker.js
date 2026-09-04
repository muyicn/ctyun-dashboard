class UpstreamChecker {
  constructor(onLog, onNotify) {
    this.repo = 'bytehola/ctyun-auto';
    this.repoUrl = `https://github.com/${this.repo}`;
    this.onLog = onLog || console.log;
    this.onNotify = onNotify || (() => {});
    this.currentVersion = '65c077b'; // 当前集成的上游最新基准 commit
    this.latestInfo = {
      version: this.currentVersion,
      commitDate: '2026-06-21',
      commitMessage: '替换阿里云源镜像',
      hasUpdate: false,
      lastCheckedAt: '',
      repoUrl: this.repoUrl
    };
    this.checkTimer = null;
  }

  async check() {
    this.latestInfo.lastCheckedAt = new Date().toISOString().replace('T', ' ').substring(0, 19);
    try {
      const res = await fetch(`https://api.github.com/repos/${this.repo}/commits/main`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      if (res.status === 200) {
        const data = await res.json();
        const latestSha = (data.sha || '').substring(0, 7);
        const commitMsg = (data.commit?.message || '').split('\n')[0];
        const dateStr = (data.commit?.committer?.date || '').substring(0, 10);

        this.latestInfo.version = latestSha;
        this.latestInfo.commitDate = dateStr;
        this.latestInfo.commitMessage = commitMsg;

        if (latestSha && latestSha !== this.currentVersion) {
          this.latestInfo.hasUpdate = true;
          const notifyTitle = `🚀 上游项目 ${this.repo} 检测到新版本更新！`;
          const notifyContent = `最新提交: ${latestSha}\n更新内容: ${commitMsg}\n发布日期: ${dateStr}\n项目地址: ${this.repoUrl}`;
          this.onLog('System', notifyTitle, 'warning');
          this.onNotify(notifyTitle, notifyContent);
        } else {
          this.latestInfo.hasUpdate = false;
        }
      }
    } catch (e) {
      // 网络受阻时不影响主业务
    }
  }

  startAutoCheck(intervalMinutes = 60) {
    this.check();
    this.checkTimer = setInterval(() => this.check(), intervalMinutes * 60 * 1000);
  }

  stop() {
    if (this.checkTimer) clearInterval(this.checkTimer);
  }
}

module.exports = UpstreamChecker;
