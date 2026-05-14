const router = require('express').Router();
const db = require('../db');
const { authMiddleware, adminMiddleware } = require('../auth');

router.use(authMiddleware, adminMiddleware);

router.get('/stats', (req, res) => {
  const users = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const chats = db.prepare('SELECT COUNT(*) as c FROM chats').get().c;
  const messages = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
  res.json({ users, chats, messages });
});

router.get('/users', (req, res) => {
  const users = db.prepare('SELECT id, username, display_name, is_admin, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

router.get('/chats', (req, res) => {
  const chats = db.prepare(`
    SELECT c.id, c.type, c.name, c.created_at,
      (SELECT COUNT(*) FROM messages WHERE chat_id = c.id) as message_count,
      (SELECT COUNT(*) FROM chat_members WHERE chat_id = c.id) as member_count
    FROM chats c ORDER BY c.created_at DESC
  `).all();
  res.json(chats);
});

module.exports = router;
