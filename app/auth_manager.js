const crypto = require('crypto');

function hashPassword(password, salt = 'ctyun_salt_2026') {
  return crypto.createHash('sha256').update(password + salt).digest('hex');
}

class AuthManager {
  constructor(configManager) {
    this.configManager = configManager;
    this.sessions = new Map(); // token -> { userId, username, role, expiresAt }
    this.initAdminUser();
  }

  initAdminUser() {
    const cfg = this.configManager.config;
    if (!cfg.users) cfg.users = [];

    // 按角色判定而非用户名字面量：只要系统中已存在任意管理员（含被改名的），
    // 一律不再注入默认账号，避免管理员改名/删除后被凭空重建。
    // 仅在系统完全没有管理员时（全新部署或误删全部管理员的兜底防锁死）才创建默认 admin。
    const hasAnyAdmin = cfg.users.some(u => u.role === 'admin');
    if (hasAnyAdmin) return;

    const admin = {
      id: 'u_admin',
      username: 'admin',
      passwordHash: hashPassword('admin123'),
      role: 'admin',
      maxQuota: 999,
      createdAt: new Date().toISOString()
    };
    cfg.users.push(admin);
    this.configManager.saveConfig();
  }

  createSession(user) {
    const token = crypto.randomUUID().replace(/-/g, '');
    const session = {
      userId: user.id,
      username: user.username,
      role: user.role,
      maxQuota: user.maxQuota || 2,
      expiresAt: Date.now() + 30 * 24 * 3600 * 1000 // 30天
    };
    this.sessions.set(token, session);
    return token;
  }

  verifySession(token) {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token);
      return null;
    }
    // 动态同步最新用户的 maxQuota、role 和 avatar
    const user = this.getUserById(session.userId);
    if (user) {
      session.role = user.role;
      session.maxQuota = user.maxQuota;
      session.avatar = user.avatar || '';
    }
    return session;
  }

  login(username, password) {
    const cfg = this.configManager.config;
    const user = (cfg.users || []).find(u => u.username === username);
    if (!user) return { success: false, error: '用户不存在' };

    const hash = hashPassword(password);
    if (user.passwordHash !== hash) {
      return { success: false, error: '密码错误' };
    }

    const token = this.createSession(user);
    return {
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        maxQuota: user.maxQuota,
        avatar: user.avatar || ''
      }
    };
  }

  register(username, password) {
    const cfg = this.configManager.config;
    // 默认不开放注册，必须由管理员在后台系统设置中开启
    if (cfg.settings?.allowRegistration !== true) {
      return { success: false, error: '管理员未开放新用户自行注册功能，请联系管理员！' };
    }

    if (!cfg.users) cfg.users = [];

    const cleanUser = username.trim();
    if (!cleanUser || !password) {
      return { success: false, error: '用户名和密码不能为空' };
    }

    if (cfg.users.some(u => u.username === cleanUser)) {
      return { success: false, error: '该用户名已被注册，请直接登录' };
    }

    const defaultQuota = cfg.settings?.defaultQuota || 2;
    const newUser = {
      id: 'u_' + crypto.randomUUID().substring(0, 8),
      username: cleanUser,
      passwordHash: hashPassword(password),
      role: 'user',
      maxQuota: defaultQuota,
      avatar: '',
      createdAt: new Date().toISOString()
    };

    cfg.users.push(newUser);
    this.configManager.saveConfig();

    const token = this.createSession(newUser);
    return {
      success: true,
      token,
      user: {
        id: newUser.id,
        username: newUser.username,
        role: newUser.role,
        maxQuota: newUser.maxQuota,
        avatar: newUser.avatar || ''
      }
    };
  }

  getUserById(userId) {
    const cfg = this.configManager.config;
    return (cfg.users || []).find(u => u.id === userId);
  }

  getUserNotify(userId) {
    const user = this.getUserById(userId);
    return user?.notify || null;
  }

  updateUserNotify(userId, notifyConfig) {
    const cfg = this.configManager.config;
    const user = (cfg.users || []).find(u => u.id === userId);
    if (!user) return false;
    user.notify = {
      enabled: !!notifyConfig?.enabled,
      channel: notifyConfig?.channel || 'webhook',
      webhookUrl: String(notifyConfig?.webhookUrl || '').trim(),
      customTitleTemplate: String(notifyConfig?.customTitleTemplate || '').trim(),
      customContentTemplate: String(notifyConfig?.customContentTemplate || '').trim()
    };
    this.configManager.saveConfig();
    return true;
  }

  getUsers() {
    const cfg = this.configManager.config;
    return (cfg.users || []).map(u => {
      const accountsCount = (cfg.accounts || []).filter(a => a.ownerId === u.id).length;
      return {
        id: u.id,
        username: u.username,
        role: u.role,
        maxQuota: u.maxQuota || 2,
        accountsCount,
        createdAt: u.createdAt
      };
    });
  }

  updateUserQuota(userId, maxQuota) {
    const cfg = this.configManager.config;
    const user = (cfg.users || []).find(u => u.id === userId);
    if (!user) return false;
    user.maxQuota = parseInt(maxQuota) || 2;
    this.configManager.saveConfig();
    return true;
  }

  updateUserPassword(userId, newPassword) {
    const cfg = this.configManager.config;
    const user = (cfg.users || []).find(u => u.id === userId);
    if (!user) return false;
    user.passwordHash = hashPassword(newPassword);
    this.configManager.saveConfig();
    return true;
  }

  updateUserAvatar(userId, avatar) {
    const cfg = this.configManager.config;
    const user = (cfg.users || []).find(u => u.id === userId);
    if (!user) return false;
    user.avatar = String(avatar || '').trim();
    // 同步活跃会话
    for (const [token, s] of this.sessions.entries()) {
      if (s.userId === userId) s.avatar = user.avatar;
    }
    this.configManager.saveConfig();
    return true;
  }

  updateAdminUsername(oldUsername, newUsername) {
    const cfg = this.configManager.config;
    const cleanNew = (newUsername || '').trim();
    if (!cleanNew) return { success: false, error: '新管理员用户名不能为空' };
    if (cfg.users.some(u => u.username === cleanNew && u.username !== oldUsername)) {
      return { success: false, error: '该用户名已被其他账号占用' };
    }

    const admin = (cfg.users || []).find(u => u.username === oldUsername && u.role === 'admin');
    if (!admin) return { success: false, error: '管理员账号不存在' };

    admin.username = cleanNew;
    // 同步更新当前会话里的 username
    for (const [token, s] of this.sessions.entries()) {
      if (s.userId === admin.id) s.username = cleanNew;
    }
    this.configManager.saveConfig();
    return { success: true, newUsername: cleanNew };
  }

  deleteUser(userId) {
    const cfg = this.configManager.config;
    const user = (cfg.users || []).find(u => u.id === userId);
    if (!user || user.role === 'admin') return false;
    cfg.users = cfg.users.filter(u => u.id !== userId);
    // 同时清理该用户的会话
    for (const [token, s] of this.sessions.entries()) {
      if (s.userId === userId) this.sessions.delete(token);
    }
    this.configManager.saveConfig();
    return true;
  }
}

module.exports = { AuthManager, hashPassword };
