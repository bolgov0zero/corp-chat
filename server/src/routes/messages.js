const router = require('express').Router();
const db = require('../db');
const { authMiddleware } = require('../auth');

// Get messages for a chat (with status)
router.get('/chat/:chatId', authMiddleware, (req, res) => {
  const { chatId } = req.params;
  if (!db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, req.user.id))
    return res.status(403).json({ error: 'Not a member' });

  const messages = db.prepare(`
    SELECT m.id, m.chat_id, m.text, m.sent_at, m.edited_at, m.deleted,
      u.id as sender_id, u.display_name as sender_name
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.chat_id = ? ORDER BY m.sent_at ASC
  `).all(chatId);

  const memberCount = db.prepare('SELECT COUNT(*) as c FROM chat_members WHERE chat_id = ?').get(chatId).c;

  const result = messages.map(m => {
    const delivered = db.prepare('SELECT COUNT(*) as c FROM message_status WHERE message_id = ? AND delivered_at IS NOT NULL').get(m.id).c;
    const read = db.prepare('SELECT COUNT(*) as c FROM message_status WHERE message_id = ? AND read_at IS NOT NULL').get(m.id).c;
    return { ...m, status: { delivered, read, total: memberCount - 1 } };
  });

  res.json(result);
});

module.exports = router;
