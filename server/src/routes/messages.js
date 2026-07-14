const router = require('express').Router();
const db = require('../db');
const { authMiddleware } = require('../auth');

// Получить сообщения чата с пагинацией (query: before, limit)
router.get('/chat/:chatId', authMiddleware, (req, res) => {
  const { chatId } = req.params;
  if (!db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, req.user.id))
    return res.status(403).json({ error: 'Not a member' });

  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const before = req.query.before ? parseInt(req.query.before) : null;

  // Запрашиваем в обратном порядке, потом переворачиваем — так проще делать cursor-пагинацию
  const rows = before
    ? db.prepare(`
        SELECT m.id, m.chat_id, m.text, m.sent_at, m.edited_at, m.deleted, m.attachment,
          u.id as sender_id, COALESCE(u.display_name, 'Удалённый аккаунт') as sender_name, u.tag as sender_tag,
          m.reply_to_id,
          rm.text as reply_text, rm.deleted as reply_deleted,
          COALESCE(ru.display_name, 'Удалённый аккаунт') as reply_sender_name
        FROM messages m LEFT JOIN users u ON u.id = m.sender_id
        LEFT JOIN messages rm ON rm.id = m.reply_to_id
        LEFT JOIN users ru ON ru.id = rm.sender_id
        WHERE m.chat_id = ? AND m.id < ?
        ORDER BY m.id DESC LIMIT ?
      `).all(chatId, before, limit)
    : db.prepare(`
        SELECT m.id, m.chat_id, m.text, m.sent_at, m.edited_at, m.deleted, m.attachment,
          u.id as sender_id, COALESCE(u.display_name, 'Удалённый аккаунт') as sender_name, u.tag as sender_tag,
          m.reply_to_id,
          rm.text as reply_text, rm.deleted as reply_deleted,
          COALESCE(ru.display_name, 'Удалённый аккаунт') as reply_sender_name
        FROM messages m LEFT JOIN users u ON u.id = m.sender_id
        LEFT JOIN messages rm ON rm.id = m.reply_to_id
        LEFT JOIN users ru ON ru.id = rm.sender_id
        WHERE m.chat_id = ?
        ORDER BY m.id DESC LIMIT ?
      `).all(chatId, limit);

  // Возвращаем в хронологическом порядке (от старых к новым)
  const messages = rows.reverse();

  // hasMore = true если вернулось ровно limit записей (значит, возможно, есть ещё)
  const hasMore = rows.length === limit;

  const memberCount = db.prepare('SELECT COUNT(*) as c FROM chat_members WHERE chat_id = ?').get(chatId).c;

  const getDelivered = db.prepare('SELECT COUNT(*) as c FROM message_status WHERE message_id = ? AND delivered_at IS NOT NULL');
  const getRead = db.prepare('SELECT COUNT(*) as c FROM message_status WHERE message_id = ? AND read_at IS NOT NULL');
  const getReactions = db.prepare('SELECT reaction, COUNT(*) as count FROM reactions WHERE message_id = ? GROUP BY reaction');

  const result = messages.map(m => {
    const delivered = getDelivered.get(m.id).c;
    const read = getRead.get(m.id).c;
    const reactions = getReactions.all(m.id);
    let attachment = null;
    if (m.attachment) { try { attachment = JSON.parse(m.attachment); } catch {} }
    return { ...m, attachment, status: { delivered, read, total: memberCount - 1 }, reactions };
  });

  res.json({ messages: result, hasMore });
});

// Получить детальную информацию о доставке/прочтении одного сообщения
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
