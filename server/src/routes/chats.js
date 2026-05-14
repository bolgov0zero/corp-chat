const router = require('express').Router();
const db = require('../db');
const { authMiddleware, adminMiddleware } = require('../auth');

function enrichChat(chat, userId) {
  const members = db.prepare(`
    SELECT u.id, u.username, u.display_name FROM users u
    JOIN chat_members cm ON cm.user_id = u.id WHERE cm.chat_id = ?
  `).all(chat.id);
  const last = db.prepare(`
    SELECT m.id, m.text, m.sent_at, m.edited_at, m.deleted, u.display_name as sender_name, u.id as sender_id
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.chat_id = ? ORDER BY m.sent_at DESC LIMIT 1
  `).get(chat.id);
  return { ...chat, members, last_message: last || null };
}

// Get my chats
router.get('/', authMiddleware, (req, res) => {
  const chats = db.prepare(`
    SELECT c.id, c.type, c.name, c.created_at, c.created_by
    FROM chats c JOIN chat_members cm ON cm.chat_id = c.id
    WHERE cm.user_id = ?
    ORDER BY (SELECT COALESCE(MAX(sent_at), 0) FROM messages WHERE chat_id = c.id) DESC
  `).all(req.user.id);
  res.json(chats.map(c => enrichChat(c, req.user.id)));
});

// Create direct chat
router.post('/direct', authMiddleware, (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });
  const existing = db.prepare(`
    SELECT c.id FROM chats c
    JOIN chat_members cm1 ON cm1.chat_id = c.id AND cm1.user_id = ?
    JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id = ?
    WHERE c.type = 'direct' LIMIT 1
  `).get(req.user.id, user_id);
  if (existing) return res.json(enrichChat(existing, req.user.id));
  const result = db.prepare("INSERT INTO chats (type, created_by) VALUES ('direct', ?)").run(req.user.id);
  db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?), (?, ?)').run(result.lastInsertRowid, req.user.id, result.lastInsertRowid, user_id);
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(result.lastInsertRowid);
  res.json(enrichChat(chat, req.user.id));
});

// Create group / room
router.post('/group', authMiddleware, (req, res) => {
  const { name, member_ids } = req.body;
  if (!name?.trim() || !Array.isArray(member_ids)) return res.status(400).json({ error: 'Missing fields' });
  const result = db.prepare("INSERT INTO chats (type, name, created_by) VALUES ('group', ?, ?)").run(name.trim(), req.user.id);
  const allMembers = [...new Set([req.user.id, ...member_ids])];
  const ins = db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)');
  allMembers.forEach(uid => ins.run(result.lastInsertRowid, uid));
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(result.lastInsertRowid);
  res.json(enrichChat(chat, req.user.id));
});

// Edit group name
router.patch('/:id', authMiddleware, (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat || chat.type !== 'group') return res.status(404).json({ error: 'Not found' });
  if (!db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(req.params.id, req.user.id))
    return res.status(403).json({ error: 'Not a member' });
  const { name } = req.body;
  if (name?.trim()) db.prepare('UPDATE chats SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
  res.json(enrichChat(db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id), req.user.id));
});

// Add member to group
router.post('/:id/members', authMiddleware, (req, res) => {
  const { user_id } = req.body;
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat || chat.type !== 'group') return res.status(404).json({ error: 'Not found' });
  if (!db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(req.params.id, req.user.id))
    return res.status(403).json({ error: 'Not a member' });
  try {
    db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)').run(req.params.id, user_id);
  } catch {}
  res.json({ ok: true });
});

// Remove member from group
router.delete('/:id/members/:userId', authMiddleware, (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat || chat.type !== 'group') return res.status(404).json({ error: 'Not found' });
  const isMember = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(req.params.id, req.user.id);
  const isAdmin = req.user.is_admin;
  if (!isMember && !isAdmin) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(req.params.id, req.params.userId);
  res.json({ ok: true });
});

// Leave group (not allowed for rooms)
router.post('/:id/leave', authMiddleware, (req, res) => {
  const chat = db.prepare('SELECT type FROM chats WHERE id = ?').get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Not found' });
  if (chat.type === 'room') return res.status(403).json({ error: 'Cannot leave a room' });
  db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// Delete own direct chat (just removes you from it)
router.delete('/:id', authMiddleware, (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Not found' });
  if (!db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(req.params.id, req.user.id))
    return res.status(403).json({ error: 'Not a member' });
  if (chat.type === 'direct') {
    db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(req.params.id, req.user.id);
  } else {
    if (!req.user.is_admin && chat.created_by !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    db.prepare('DELETE FROM chats WHERE id = ?').run(req.params.id);
  }
  res.json({ ok: true });
});

// Admin: delete any chat
router.delete('/admin/:id', authMiddleware, adminMiddleware, (req, res) => {
  db.prepare('DELETE FROM chats WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Admin: clear history
router.delete('/admin/:id/messages', authMiddleware, adminMiddleware, (req, res) => {
  db.prepare('DELETE FROM messages WHERE chat_id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
