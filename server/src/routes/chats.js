const router = require('express').Router();
const db = require('../db');
const { authMiddleware, adminMiddleware } = require('../auth');

// Get my chats
router.get('/', authMiddleware, (req, res) => {
  const chats = db.prepare(`
    SELECT c.id, c.type, c.name, c.created_at,
      (SELECT COUNT(*) FROM messages WHERE chat_id = c.id) as message_count
    FROM chats c
    JOIN chat_members cm ON cm.chat_id = c.id
    WHERE cm.user_id = ?
    ORDER BY (SELECT MAX(sent_at) FROM messages WHERE chat_id = c.id) DESC NULLS LAST
  `).all(req.user.id);

  const result = chats.map(chat => {
    const members = db.prepare(`
      SELECT u.id, u.username, u.display_name FROM users u
      JOIN chat_members cm ON cm.user_id = u.id
      WHERE cm.chat_id = ?
    `).all(chat.id);
    const lastMessage = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY sent_at DESC LIMIT 1').get(chat.id);
    return { ...chat, members, last_message: lastMessage || null };
  });

  res.json(result);
});

// Get messages for a chat
router.get('/:id/messages', authMiddleware, (req, res) => {
  const member = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!member) return res.status(403).json({ error: 'Not a member' });

  const messages = db.prepare(`
    SELECT m.id, m.text, m.sent_at, u.id as sender_id, u.display_name as sender_name
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.chat_id = ?
    ORDER BY m.sent_at ASC
  `).all(req.params.id);
  res.json(messages);
});

// Create direct chat
router.post('/direct', authMiddleware, (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });

  // Check if direct chat already exists between these two users
  const existing = db.prepare(`
    SELECT c.id FROM chats c
    JOIN chat_members cm1 ON cm1.chat_id = c.id AND cm1.user_id = ?
    JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id = ?
    WHERE c.type = 'direct'
    LIMIT 1
  `).get(req.user.id, user_id);

  if (existing) return res.json({ id: existing.id });

  const chat = db.prepare("INSERT INTO chats (type, created_by) VALUES ('direct', ?)").run(req.user.id);
  db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?), (?, ?)').run(chat.lastInsertRowid, req.user.id, chat.lastInsertRowid, user_id);
  res.json({ id: chat.lastInsertRowid });
});

// Create group chat
router.post('/group', authMiddleware, (req, res) => {
  const { name, member_ids } = req.body;
  if (!name || !Array.isArray(member_ids)) return res.status(400).json({ error: 'Missing fields' });

  const chat = db.prepare("INSERT INTO chats (type, name, created_by) VALUES ('group', ?, ?)").run(name, req.user.id);
  const allMembers = [...new Set([req.user.id, ...member_ids])];
  const insertMember = db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)');
  allMembers.forEach(uid => insertMember.run(chat.lastInsertRowid, uid));
  res.json({ id: chat.lastInsertRowid });
});

// Admin: delete chat
router.delete('/:id', authMiddleware, adminMiddleware, (req, res) => {
  db.prepare('DELETE FROM chats WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Admin: clear chat history
router.delete('/:id/messages', authMiddleware, adminMiddleware, (req, res) => {
  db.prepare('DELETE FROM messages WHERE chat_id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
