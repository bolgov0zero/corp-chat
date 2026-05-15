const router = require('express').Router();
const db = require('../db');
const { authMiddleware, adminMiddleware } = require('../auth');
const { sendTo, getStatus, getClients, sendToConn } = require('../ws');

router.use(authMiddleware, adminMiddleware);

router.get('/stats', (req, res) => {
  res.json({
    users: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    chats: db.prepare("SELECT COUNT(*) as c FROM chats WHERE type='direct'").get().c,
    groups: db.prepare("SELECT COUNT(*) as c FROM chats WHERE type='group'").get().c,
    rooms: db.prepare("SELECT COUNT(*) as c FROM chats WHERE type='room'").get().c,
    messages: db.prepare('SELECT COUNT(*) as c FROM messages WHERE deleted = 0').get().c,
  });
});

// Create room (admin only) — notifies members via WS
router.post('/rooms', (req, res) => {
  const { name, member_ids } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Missing name' });
  const result = db.prepare("INSERT INTO chats (type, name, created_by) VALUES ('room', ?, ?)").run(name.trim(), req.user.id);
  const chatId = result.lastInsertRowid;
  if (Array.isArray(member_ids) && member_ids.length) {
    const ins = db.prepare('INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)');
    member_ids.forEach(uid => { ins.run(chatId, uid); sendTo(uid, { type: 'reload_chats' }); });
  }
  res.json({ id: chatId });
});

// Add member to any chat/room — notify via WS
router.post('/chats/:id/members', (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });
  db.prepare('INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)').run(req.params.id, Number(user_id));
  sendTo(Number(user_id), { type: 'reload_chats' });
  res.json({ ok: true });
});

// Remove member from any chat/room
router.delete('/chats/:id/members/:userId', (req, res) => {
  db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(req.params.id, req.params.userId);
  res.json({ ok: true });
});

router.get('/users', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const avatarDir = path.join(__dirname, '..', '..', '..', 'chat_db', 'avatar');
  const users = db.prepare('SELECT id, username, display_name, is_admin, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users.map(u => ({
    ...u,
    status: getStatus(u.id),
    has_avatar: fs.existsSync(path.join(avatarDir, `${u.id}.jpg`)),
  })));
});

router.get('/chats', (req, res) => {
  const chats = db.prepare(`
    SELECT c.id, c.type, c.name, c.created_at, c.created_by,
      (SELECT COUNT(*) FROM messages WHERE chat_id = c.id AND deleted = 0) as message_count,
      (SELECT COUNT(*) FROM chat_members WHERE chat_id = c.id) as member_count,
      (SELECT GROUP_CONCAT(u.display_name, '|||') FROM users u
       JOIN chat_members cm ON cm.user_id = u.id WHERE cm.chat_id = c.id ORDER BY cm.joined_at) as member_names
    FROM chats c ORDER BY c.created_at DESC
  `).all();
  res.json(chats.map(c => ({ ...c, member_names: c.member_names ? c.member_names.split('|||') : [] })));
});

router.get('/chats/:id/members', (req, res) => {
  const members = db.prepare(`
    SELECT u.id, u.username, u.display_name, cm.joined_at FROM users u
    JOIN chat_members cm ON cm.user_id = u.id WHERE cm.chat_id = ? ORDER BY cm.joined_at
  `).all(req.params.id);
  res.json(members);
});

// ── Кэш версии с GitHub (обновляется раз в 15 минут) ──
let _versionCache = { version: null, fetchedAt: 0 };
const VERSION_CACHE_TTL = 15 * 60 * 1000;

async function fetchLatestVersion(force = false) {
  const now = Date.now();
  if (!force && _versionCache.version && now - _versionCache.fetchedAt < VERSION_CACHE_TTL) {
    return _versionCache.version;
  }
  const https = require('https');
  try {
    const token = db.prepare("SELECT value FROM settings WHERE key = 'github_token'").get()?.value;
    const headers = { 'User-Agent': 'Electron-Admin' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const data = await new Promise((resolve, reject) => {
      https.get('https://api.github.com/repos/bolgov0zero/corp-chat/releases/latest',
        { headers },
        r => { let body = ''; r.on('data', c => body += c); r.on('end', () => resolve(JSON.parse(body))); r.on('error', reject); }
      ).on('error', reject);
    });
    if (data.tag_name) {
      _versionCache = { version: data.tag_name.replace(/^v/, ''), fetchedAt: now };
    }
  } catch {}
  return _versionCache.version;
}

// Список подключённых клиентов + последняя версия с GitHub
router.get('/clients', async (req, res) => {
  const clients = getClients();
  const latestVersion = await fetchLatestVersion(req.query.force === 'true');
  res.json({ clients, latestVersion });
});

// ── Настройки ──
router.get('/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
  // Маскируем токен
  if (settings.github_token) settings.github_token_set = true;
  delete settings.github_token;
  res.json(settings);
});

router.put('/settings', (req, res) => {
  const allowed = ['github_token'];
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const del = db.prepare('DELETE FROM settings WHERE key = ?');
  for (const key of allowed) {
    if (key in req.body) {
      const val = req.body[key]?.trim();
      if (val) upsert.run(key, val);
      else del.run(key);
    }
  }
  _versionCache = { version: null, fetchedAt: 0 }; // сбросить кэш
  res.json({ ok: true });
});

// Принудительное обновление
router.post('/clients/:connId/force-update', (req, res) => {
  sendToConn(Number(req.params.connId), { type: 'force_update' });
  res.json({ ok: true });
});

// Принудительный выход
router.post('/clients/:connId/force-logout', (req, res) => {
  sendToConn(Number(req.params.connId), { type: 'force_logout' });
  res.json({ ok: true });
});

module.exports = router;
