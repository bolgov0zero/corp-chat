const router = require('express').Router();
const db = require('../db');
const { authMiddleware, adminMiddleware } = require('../auth');

router.use(authMiddleware, adminMiddleware);

router.get('/stats', (req, res) => {
  res.json({
    users: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    chats: db.prepare("SELECT COUNT(*) as c FROM chats WHERE type='direct'").get().c,
    groups: db.prepare("SELECT COUNT(*) as c FROM chats WHERE type='group'").get().c,
    messages: db.prepare('SELECT COUNT(*) as c FROM messages WHERE deleted = 0').get().c,
  });
});

router.get('/users', (req, res) => {
  res.json(db.prepare('SELECT id, username, display_name, is_admin, created_at FROM users ORDER BY created_at DESC').all());
});

router.get('/chats', (req, res) => {
  const chats = db.prepare(`
    SELECT c.id, c.type, c.name, c.created_at, c.created_by,
      (SELECT COUNT(*) FROM messages WHERE chat_id = c.id AND deleted = 0) as message_count,
      (SELECT COUNT(*) FROM chat_members WHERE chat_id = c.id) as member_count
    FROM chats c ORDER BY c.created_at DESC
  `).all();
  res.json(chats);
});

router.get('/chats/:id/members', (req, res) => {
  const members = db.prepare(`
    SELECT u.id, u.username, u.display_name, cm.joined_at FROM users u
    JOIN chat_members cm ON cm.user_id = u.id WHERE cm.chat_id = ? ORDER BY cm.joined_at
  `).all(req.params.id);
  res.json(members);
});

module.exports = router;
