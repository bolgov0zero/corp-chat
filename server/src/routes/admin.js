const router = require('express').Router();
const db = require('../db');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { authMiddleware, adminMiddleware } = require('../auth');
const { sendTo, getStatus, isConnected, getClients, sendToConn, getConnCount, getConnMeta, initUpdateProgress, getUpdateProgress } = require('../ws');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', '..', 'chat_db', 'chat.db');
const FILES_DIR = path.join(path.dirname(DB_PATH), 'files');

function getDirSize(dir) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      try { total += fs.statSync(path.join(dir, f)).size; } catch {}
    }
  } catch {}
  return total;
}

function getDirCount(dir) {
  try { return fs.readdirSync(dir).length; } catch { return 0; }
}

// ── Версия сервера ──
const VERSION_FILE = path.join(__dirname, '..', '..', 'version.json');
function getLocalVersion() {
  try { return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')).version; } catch { return '0.0.0'; }
}

function fetchRemoteVersion() {
  return new Promise((resolve) => {
    try {
      const token = db.prepare("SELECT value FROM settings WHERE key = 'github_token'").get()?.value;
      const headers = { 'User-Agent': 'Electron-Server', 'Accept': 'application/vnd.github.v3+json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      // Используем GitHub API — не кешируется CDN, в отличие от raw.githubusercontent.com
      const req = https.request({
        hostname: 'api.github.com',
        path: '/repos/bolgov0zero/corp-chat/contents/server/version.json',
        headers,
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            // Контент закодирован в base64
            const content = Buffer.from(json.content, 'base64').toString('utf8');
            resolve(JSON.parse(content).version);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.end();
    } catch { resolve(null); }
  });
}

router.use(authMiddleware, adminMiddleware);

router.get('/stats', (req, res) => {
  const pageCount = db.prepare('PRAGMA page_count').get()['page_count'];
  const pageSize  = db.prepare('PRAGMA page_size').get()['page_size'];
  res.json({
    users:    db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    chats:    db.prepare("SELECT COUNT(*) as c FROM chats WHERE type='direct'").get().c,
    groups:   db.prepare("SELECT COUNT(*) as c FROM chats WHERE type='group'").get().c,
    rooms:    db.prepare("SELECT COUNT(*) as c FROM chats WHERE type='room'").get().c,
    messages: db.prepare('SELECT COUNT(*) as c FROM messages WHERE deleted = 0').get().c,
    uptimeSeconds: Math.floor(process.uptime()),
    dbBytes: pageCount * pageSize,
    filesBytes: getDirSize(FILES_DIR),
    filesCount: getDirCount(FILES_DIR),
    wsConnections: getConnCount(),
    serverVersion: getLocalVersion(),
    pushSubscriptions: (() => { try { return db.prepare('SELECT COUNT(*) as c FROM push_subscriptions').get().c; } catch { return 0; } })(),
  });
});

// Message activity for sparkline chart
router.get('/activity', (req, res) => {
  const range = req.query.range || '24h';

  if (range === '24h') {
    // 24 hourly buckets (oldest → newest)
    const now = Math.floor(Date.now() / 1000);
    const since = now - 86400;
    const rows = db.prepare(`
      SELECT CAST((sent_at - ?) / 3600 AS INTEGER) AS bucket, COUNT(*) AS count
      FROM messages WHERE deleted=0 AND sent_at >= ?
      GROUP BY bucket
    `).all(since, since);
    const points = new Array(24).fill(0);
    rows.forEach(r => { if (r.bucket >= 0 && r.bucket < 24) points[r.bucket] = r.count; });
    const labels = [0, 6, 12, 18, 24].map(offset => {
      const d = new Date((since + offset * 3600) * 1000);
      return d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
    });
    return res.json({ points, labels });
  }

  if (range === '7d') {
    const rows = db.prepare(`
      SELECT CAST((unixepoch('now') - sent_at) / 86400 AS INTEGER) AS days_ago, COUNT(*) AS count
      FROM messages WHERE deleted=0 AND sent_at >= unixepoch('now') - 7*86400
      GROUP BY days_ago
    `).all();
    const points = new Array(7).fill(0);
    rows.forEach(r => { const i = 6 - r.days_ago; if (i >= 0 && i < 7) points[i] = r.count; });
    const ruDay = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
    const labels = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() - (6 - i));
      return ruDay[d.getDay()];
    });
    return res.json({ points, labels });
  }

  // 30d
  const rows = db.prepare(`
    SELECT CAST((unixepoch('now') - sent_at) / 86400 AS INTEGER) AS days_ago, COUNT(*) AS count
    FROM messages WHERE deleted=0 AND sent_at >= unixepoch('now') - 30*86400
    GROUP BY days_ago
  `).all();
  const points = new Array(30).fill(0);
  rows.forEach(r => { const i = 29 - r.days_ago; if (i >= 0 && i < 30) points[i] = r.count; });
  const labels = Array.from({ length: 5 }, (_, i) => String(Math.round(i * 7.5) + 1));
  res.json({ points, labels });
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
  const chatId = Number(req.params.id);
  const kickedId = Number(req.params.userId);
  const remaining = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?').all(chatId, kickedId);
  db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(chatId, kickedId);
  remaining.forEach(({ user_id }) => sendTo(user_id, { type: 'reload_chats' }));
  sendTo(kickedId, { type: 'chat_deleted', chat_id: chatId });
  res.json({ ok: true });
});

// Rename room
router.patch('/rooms/:id', (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Missing name' });
  db.prepare("UPDATE chats SET name = ? WHERE id = ? AND type = 'room'").run(name.trim(), req.params.id);
  const members = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(req.params.id);
  members.forEach(({ user_id }) => sendTo(user_id, { type: 'chat_updated', chat_id: Number(req.params.id), name: name.trim() }));
  res.json({ ok: true });
});

// Upload avatar for any chat/room (admin)
function isImgBuf(buf) {
  return (buf[0]===0xFF&&buf[1]===0xD8)||(buf[0]===0x89&&buf[1]===0x50)||
         (buf[0]===0x47&&buf[1]===0x49)||(buf[0]===0x52&&buf[1]===0x49);
}
router.post('/chats/:id/avatar', (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ error: 'Missing data' });
  const buf = Buffer.from(data, 'base64');
  if (!isImgBuf(buf)) return res.status(400).json({ error: 'Not an image' });
  const avatarDir = path.join(__dirname, '..', '..', '..', 'chat_db', 'avatar');
  fs.mkdirSync(avatarDir, { recursive: true });
  fs.writeFileSync(path.join(avatarDir, `chat_${req.params.id}.jpg`), buf);
  res.json({ ok: true });
});

router.get('/users', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const avatarDir = path.join(__dirname, '..', '..', '..', 'chat_db', 'avatar');
  const users = db.prepare('SELECT id, username, display_name, is_admin, tag, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users.map(u => ({
    ...u,
    connected: isConnected(u.id),
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

// ── Кэш последней версии клиента с GitHub Releases (обновляется раз в 15 минут) ──
let _versionCache = { version: null, fetchedAt: 0 };
const VERSION_CACHE_TTL = 15 * 60 * 1000;

// Возвращает последнюю версию клиента из releases/latest (тег вида c1.4.x → 1.4.x).
// Используется для сравнения с clientVersion, которую клиент присылает при подключении.
async function fetchLatestVersion(force = false) {
  const now = Date.now();
  if (!force && _versionCache.version && now - _versionCache.fetchedAt < VERSION_CACHE_TTL) {
    return _versionCache.version;
  }
  try {
    const token = db.prepare("SELECT value FROM settings WHERE key = 'github_token'").get()?.value;
    const headers = { 'User-Agent': 'Electron-Admin', 'Accept': 'application/vnd.github.v3+json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const data = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.github.com',
        path: '/repos/bolgov0zero/corp-chat/releases/latest',
        headers,
      }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('parse')); } });
      });
      req.on('error', reject);
      req.end();
    });
    if (data.tag_name) {
      _versionCache = { version: data.tag_name.replace(/^[a-zA-Z]+/, ''), fetchedAt: now };
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
  // Секреты не должны уходить в браузер даже админу
  delete settings.jwt_secret;
  delete settings.vapid_private;
  res.json(settings);
});

router.put('/settings', (req, res) => {
  const allowed = ['github_token', 'edit_time_limit',
    'upload_image_max_size', 'upload_image_extensions',
    'upload_file_max_size', 'upload_file_extensions', 'upload_file_lifetime'];
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const del = db.prepare('DELETE FROM settings WHERE key = ?');
  const keepEmpty = ['upload_image_extensions', 'upload_file_extensions', 'upload_file_lifetime'];
  for (const key of allowed) {
    if (key in req.body) {
      const val = req.body[key]?.trim() ?? '';
      if (val || keepEmpty.includes(key)) upsert.run(key, val);
      else del.run(key);
    }
  }
  _versionCache = { version: null, fetchedAt: 0 }; // сбросить кэш
  res.json({ ok: true });
});

// Принудительное обновление — сервер сам находит нужный ассет по платформе клиента
router.post('/clients/:connId/force-update', async (req, res) => {
  const connId = Number(req.params.connId);
  const meta = getConnMeta(connId);
  const platform = meta?.osPlatform || '';
  let downloadUrl = null;
  try {
    const token = db.prepare("SELECT value FROM settings WHERE key = 'github_token'").get()?.value;
    const headers = { 'User-Agent': 'Electron-Admin', 'Accept': 'application/vnd.github.v3+json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const data = await new Promise((resolve, reject) => {
      const req2 = https.request({ hostname: 'api.github.com', path: '/repos/bolgov0zero/corp-chat/releases/latest', headers }, r => {
        let body = ''; r.on('data', c => body += c); r.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(); } });
      });
      req2.on('error', reject);
      req2.end();
    });
    const assets = data.assets || [];
    // Выбираем ассет по платформе; для Linux предпочитаем x86_64 если платформа не arm
    const asset = platform === 'win32'  ? assets.find(a => /\.exe$/i.test(a.name))
                : platform === 'darwin' ? assets.find(a => /\.dmg$/i.test(a.name))
                : assets.find(a => /x86_64\.AppImage$/i.test(a.name)) || assets.find(a => /\.AppImage$/i.test(a.name));
    downloadUrl = asset?.browser_download_url || null;
  } catch {}
  initUpdateProgress(connId);
  sendToConn(connId, { type: 'force_update', downloadUrl });
  res.json({ ok: true, downloadUrl });
});

router.get('/updates/progress', (req, res) => {
  res.json(getUpdateProgress());
});

// Завершить ВСЕ сессии пользователя (все устройства)
router.post('/users/:id/logout', (req, res) => {
  sendTo(Number(req.params.id), { type: 'force_logout' });
  res.json({ ok: true });
});

// Принудительный выход
router.post('/clients/:connId/force-logout', (req, res) => {
  sendToConn(Number(req.params.connId), { type: 'force_logout' });
  res.json({ ok: true });
});

// Перезапуск службы systemd
router.post('/system/restart', (req, res) => {
  const { exec } = require('child_process');
  exec('systemctl is-active electron', (err, stdout) => {
    const active = (stdout || '').trim();
    if (active !== 'active' && active !== 'activating') {
      return res.status(400).json({ error: 'Служба electron не активна или не найдена. Перезапуск невозможен.' });
    }
    res.json({ ok: true });
    setTimeout(() => exec('systemctl restart electron'), 300);
  });
});

// Версия сервера
function semverGt(a, b) {
  if (!a || !b) return false;
  const n = v => v.replace(/^[^\d]*/, '').split('.').map(Number);
  const [am, an, ap] = n(a), [bm, bn, bp] = n(b);
  return am !== bm ? am > bm : an !== bn ? an > bn : ap > bp;
}

router.get('/server/version', async (req, res) => {
  const local = getLocalVersion();
  const remote = await fetchRemoteVersion();
  res.json({ current: local, latest: remote, hasUpdate: semverGt(remote, local) });
});

// Обновление сервера с GitHub
router.post('/server/update', (req, res) => {
  const { exec } = require('child_process');
  // Проверяем, что служба управляется systemd и активна — иначе перезапуск после
  // обновления не сработает (например, установка без root), а админка не должна
  // рапортовать ложный успех.
  exec('systemctl is-active electron', (err, stdout) => {
    const active = (stdout || '').trim();
    if (active !== 'active' && active !== 'activating') {
      return res.status(400).json({ error: 'Служба electron не активна или не найдена. Обновление невозможно.' });
    }
    const appDir = path.join(__dirname, '..', '..', '..');
    // fetch + reset --hard: локальные правки на сервере не блокируют обновление,
    // untracked-файлы (chat_db) не затрагиваются. Вывод — в journal для диагностики.
    const script = `
      cd "${appDir}" && \
      git fetch origin main && \
      git reset --hard origin/main && \
      cd server && \
      npm install --omit=dev && \
      npm rebuild better-sqlite3 && \
      systemctl restart electron
    `;
    res.json({ ok: true });
    setTimeout(() => exec(script, (err, stdout, stderr) => {
      if (err) console.error('[Update] server update failed:', err.message, '\n', stderr);
      else console.log('[Update] server update applied:\n', stdout.slice(-500));
    }), 300);
  });
});

module.exports = router;
