const router = require('express').Router();
const db = require('../db');
const { authMiddleware } = require('../auth');

// Общий SELECT сообщения с данными отправителя и цитаты
const MSG_SELECT = `
  SELECT m.id, m.chat_id, m.text, m.sent_at, m.edited_at, m.deleted, m.attachment,
    u.id as sender_id, COALESCE(u.display_name, 'Удалённый аккаунт') as sender_name, u.tag as sender_tag,
    m.reply_to_id,
    rm.text as reply_text, rm.deleted as reply_deleted,
    COALESCE(ru.display_name, 'Удалённый аккаунт') as reply_sender_name
  FROM messages m LEFT JOIN users u ON u.id = m.sender_id
  LEFT JOIN messages rm ON rm.id = m.reply_to_id
  LEFT JOIN users ru ON ru.id = rm.sender_id
`;

// Полнотекстовый поиск по чатам пользователя (FTS5). Маркеры выделения — \x01/\x02,
// клиент экранирует текст и заменяет их на <b>/</b>.
router.get('/search', authMiddleware, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  const ftsQuery = q.split(/\s+/).slice(0, 8)
    .map(t => '"' + t.replace(/["]/g, '') + '"*')
    .filter(t => t !== '""*').join(' ');
  if (!ftsQuery) return res.json({ results: [] });
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT m.id, m.chat_id, m.sent_at, u.id as sender_id,
        COALESCE(u.display_name, 'Удалённый аккаунт') as sender_name,
        snippet(messages_fts, 0, char(1), char(2), '…', 10) as snippet
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
      JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ? AND cm.hidden_at IS NULL
      LEFT JOIN users u ON u.id = m.sender_id
      WHERE messages_fts MATCH ? AND m.deleted = 0
      ORDER BY m.sent_at DESC LIMIT 30
    `).all(req.user.id, ftsQuery);
  } catch (e) { console.error('[FTS] search error:', e.message); }
  res.json({ results: rows });
});

// Получить сообщения чата с пагинацией (query: before | after | around, limit)
router.get('/chat/:chatId', authMiddleware, (req, res) => {
  const { chatId } = req.params;
  if (!db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, req.user.id))
    return res.status(403).json({ error: 'Not a member' });

  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const before = req.query.before ? parseInt(req.query.before) : null;
  const after  = req.query.after  ? parseInt(req.query.after)  : null;
  const around = req.query.around ? parseInt(req.query.around) : null;

  let messages, hasMore = false, hasMoreAfter = false;

  if (around) {
    // Окно вокруг сообщения: для перехода из поиска или к цитате
    const half = Math.floor(limit / 2);
    const beforeRows = db.prepare(`${MSG_SELECT} WHERE m.chat_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`)
      .all(chatId, around, half);
    const afterRows = db.prepare(`${MSG_SELECT} WHERE m.chat_id = ? AND m.id >= ? ORDER BY m.id ASC LIMIT ?`)
      .all(chatId, around, half + 2);
    hasMore = beforeRows.length === half;
    hasMoreAfter = afterRows.length === half + 2;
    if (hasMoreAfter) afterRows.pop();
    messages = beforeRows.reverse().concat(afterRows);
  } else if (after) {
    // Догрузка вниз (после перехода вглубь истории)
    const rows = db.prepare(`${MSG_SELECT} WHERE m.chat_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT ?`)
      .all(chatId, after, limit);
    hasMoreAfter = rows.length === limit;
    messages = rows;
  } else {
    // Обычная загрузка: последние limit или страница выше before
    const rows = before
      ? db.prepare(`${MSG_SELECT} WHERE m.chat_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`).all(chatId, before, limit)
      : db.prepare(`${MSG_SELECT} WHERE m.chat_id = ? ORDER BY m.id DESC LIMIT ?`).all(chatId, limit);
    hasMore = rows.length === limit;
    messages = rows.reverse();
  }

  const memberCount = db.prepare('SELECT COUNT(*) as c FROM chat_members WHERE chat_id = ?').get(chatId).c;

  // Статусы и реакции — тремя запросами на всю страницу вместо трёх на каждое сообщение
  const ids = messages.map(m => m.id);
  const ph = ids.map(() => '?').join(',');
  const deliveredMap = new Map(), readMap = new Map(), reactionsMap = new Map();
  if (ids.length) {
    db.prepare(`SELECT message_id, COUNT(delivered_at) as d, COUNT(read_at) as r FROM message_status WHERE message_id IN (${ph}) GROUP BY message_id`)
      .all(...ids).forEach(row => { deliveredMap.set(row.message_id, row.d); readMap.set(row.message_id, row.r); });
    db.prepare(`SELECT message_id, reaction, COUNT(*) as count FROM reactions WHERE message_id IN (${ph}) GROUP BY message_id, reaction`)
      .all(...ids).forEach(row => {
        if (!reactionsMap.has(row.message_id)) reactionsMap.set(row.message_id, []);
        reactionsMap.get(row.message_id).push({ reaction: row.reaction, count: row.count });
      });
  }

  const result = messages.map(m => {
    let attachment = null;
    if (m.attachment) { try { attachment = JSON.parse(m.attachment); } catch {} }
    return {
      ...m, attachment,
      status: { delivered: deliveredMap.get(m.id) || 0, read: readMap.get(m.id) || 0, total: memberCount - 1 },
      reactions: reactionsMap.get(m.id) || [],
    };
  });

  res.json({ messages: result, hasMore, hasMoreAfter });
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
