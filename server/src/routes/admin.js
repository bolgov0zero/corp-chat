const router = require('express').Router();
const db = require('../db');
const { authMiddleware, adminMiddleware } = require('../auth');
const { sendTo, getStatus } = require('../ws');

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
  const users = db.prepare('SELECT id, username, display_name, is_admin, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users.map(u => ({ ...u, status: getStatus(u.id) })));
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

module.exports = router;
