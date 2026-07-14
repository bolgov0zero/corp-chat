const router = require('express').Router();
const bcrypt = require('bcryptjs');
const path2 = require('path');
const fs = require('fs');
const db = require('../db');
const { authMiddleware, adminMiddleware } = require('../auth');
const { getStatus, sendTo } = require('../ws');

const DB_DIR = path2.join(__dirname, '..', '..', '..', 'chat_db');
const AVATAR_DIR = path2.join(DB_DIR, 'avatar');

// Проверка магических байтов: принимаем только реальные изображения (JPEG/PNG/WebP/GIF),
// иначе на диск можно записать произвольный файл под видом аватара
function isImageBuffer(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true; // JPEG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true; // PNG
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return true; // WebP
  if (buf.slice(0, 4).toString() === 'GIF8') return true; // GIF
  return false;
}

// List all users (for starting chats)
router.get('/', authMiddleware, (req, res) => {
  const users = db.prepare('SELECT id, username, display_name FROM users WHERE id != ? ORDER BY display_name').all(req.user.id);
  res.json(users);
});

// Get presence statuses for direct chat peers
router.get('/presence', authMiddleware, (req, res) => {
  const peers = db.prepare(`
    SELECT DISTINCT u.id FROM users u
    JOIN chat_members cm1 ON cm1.user_id = u.id
    JOIN chat_members cm2 ON cm2.chat_id = cm1.chat_id AND cm2.user_id = ?
    JOIN chats c ON c.id = cm1.chat_id WHERE u.id != ? AND c.type = 'direct'
  `).all(req.user.id, req.user.id);
  const result = {};
  peers.forEach(({ id }) => { result[id] = getStatus(id); });
  res.json(result);
});

// Update own display_name
router.patch('/me', authMiddleware, (req, res) => {
  const { display_name } = req.body;
  if (!display_name?.trim()) return res.status(400).json({ error: 'Missing display_name' });
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(display_name.trim(), req.user.id);
  res.json({ ok: true });
});

// Upload own avatar (base64 JSON body: { data: "base64..." })
router.post('/me/avatar', authMiddleware, (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ error: 'No data' });
  try {
    const buf = Buffer.from(data, 'base64');
    if (!isImageBuffer(buf)) return res.status(400).json({ error: 'Not an image' });
    fs.writeFileSync(path2.join(AVATAR_DIR, `${req.user.id}.jpg`), buf);
    const peers = db.prepare(`SELECT DISTINCT cm2.user_id FROM chat_members cm1 JOIN chat_members cm2 ON cm2.chat_id = cm1.chat_id AND cm2.user_id != cm1.user_id JOIN chats c ON c.id = cm1.chat_id WHERE cm1.user_id = ?`).all(req.user.id).map(r=>r.user_id);
    peers.forEach(uid => sendTo(uid, { type: 'avatar_updated', user_id: req.user.id }));
    sendTo(req.user.id, { type: 'avatar_updated', user_id: req.user.id });
    res.json({ ok: true, url: `/api/users/${req.user.id}/avatar` });
  } catch (e) {
    console.error('avatar upload error:', e.stack || e);
    res.status(500).json({ error: 'Failed to save avatar' });
  }
});

// Serve user avatar
router.get('/:id/avatar', (req, res) => {
  const file = path2.join(AVATAR_DIR, `${req.params.id}.jpg`);
  res.sendFile(file, err => { if (err) res.status(404).end(); });
});

// Admin: create user
router.post('/', authMiddleware, adminMiddleware, (req, res) => {
  const { username, password, display_name, is_admin } = req.body;
  if (!username?.trim() || !password || !display_name?.trim()) return res.status(400).json({ error: 'Missing fields' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare('INSERT INTO users (username, password_hash, display_name, is_admin) VALUES (?, ?, ?, ?)')
      .run(username.trim(), hash, display_name.trim(), is_admin ? 1 : 0);
    res.json({ id: result.lastInsertRowid, username, display_name, is_admin: !!is_admin });
  } catch { res.status(409).json({ error: 'Username already exists' }); }
});

// Admin: edit user
router.patch('/:id', authMiddleware, adminMiddleware, (req, res) => {
  const { username, display_name, is_admin, tag } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  try {
    db.prepare('UPDATE users SET username = ?, display_name = ?, is_admin = ?, tag = ? WHERE id = ?')
      .run(username?.trim() || user.username, display_name?.trim() || user.display_name, is_admin !== undefined ? (is_admin ? 1 : 0) : user.is_admin, tag !== undefined ? (tag?.trim() || null) : user.tag, req.params.id);
    res.json({ ok: true });
  } catch { res.status(409).json({ error: 'Username already exists' }); }
});

// Admin: change password
router.patch('/:id/password', authMiddleware, adminMiddleware, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Missing password' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.params.id);
  res.json({ ok: true });
});

// Admin: delete user
// Сообщения и чаты сохраняются: sender_id/created_by обнуляются, отправитель
// отображается как «Удалённый аккаунт» (практика Telegram). Иначе DELETE падает
// по FK (messages.sender_id REFERENCES users), если пользователь что-то писал.
router.delete('/:id', authMiddleware, adminMiddleware, (req, res) => {
  const userId = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return res.status(404).json({ error: 'Not found' });
  if (userId === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  // Собеседники по общим чатам — им уйдёт reload_chats после удаления
  const peers = db.prepare(`
    SELECT DISTINCT user_id FROM chat_members
    WHERE chat_id IN (SELECT chat_id FROM chat_members WHERE user_id = ?) AND user_id != ?
  `).all(userId, userId).map(r => r.user_id);
  db.transaction(() => {
    db.prepare('UPDATE messages SET sender_id = NULL WHERE sender_id = ?').run(userId);
    db.prepare('UPDATE chats SET created_by = NULL WHERE created_by = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  })();
  sendTo(userId, { type: 'force_logout' });
  try { fs.unlinkSync(path2.join(AVATAR_DIR, `${userId}.jpg`)); } catch {}
  peers.forEach(uid => sendTo(uid, { type: 'reload_chats' }));
  res.json({ ok: true });
});

module.exports = router;
module.exports.isImageBuffer = isImageBuffer;
