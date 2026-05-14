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

// Get detailed read/delivery info for a single message
router.get('/:messageId/info', authMiddleware, (req, res) => {
  const { messageId } = req.params;
  const msg = db.prepare('SELECT m.*, c.type as chat_type FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.id = ?').get(messageId);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  if (!db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(msg.chat_id, req.user.id))
    return res.status(403).json({ error: 'Forbidden' });

  const statuses = db.prepare(`
    SELECT u.display_name, ms.delivered_at, ms.read_at
    FROM message_status ms JOIN users u ON u.id = ms.user_id
    WHERE ms.message_id = ? ORDER BY ms.read_at ASC, ms.delivered_at ASC
  `).all(messageId);

  res.json({ chat_type: msg.chat_type, sent_at: msg.sent_at, statuses });
});

module.exports = router;
