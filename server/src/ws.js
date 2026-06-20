const { WebSocketServer } = require('ws');
const db = require('./db');
const { wsAuth } = require('./auth');

// Ленивая загрузка чтобы избежать циклических зависимостей
function pushToUser(userId, payload) {
  try { require('./routes/push').sendPushToUser(userId, payload); } catch {}
}
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'chat_db', 'chat.db');
const FILES_DIR = path.join(path.dirname(DB_PATH), 'files');

function deleteAttachmentFile(attachment) {
  if (!attachment) return;
  try {
    const att = typeof attachment === 'string' ? JSON.parse(attachment) : attachment;
    if (att?.url) {
      const filename = path.basename(att.url);
      const filepath = path.join(FILES_DIR, filename);
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    }
  } catch {}
}

// userId -> Set<ws>
const clients = new Map();
// userId -> 'online'|'away'|'offline'
const userStatus = new Map();

let connCounter = 0;
// connId -> { ws, userId, username, displayName, hostname, clientVersion, osPlatform, osRelease, connectedAt }
const connMeta = new Map();

function getConn(userId) { return clients.get(userId) || new Set(); }

function broadcast(chatId, payload, excludeUserId = null) {
  const members = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId);
  members.forEach(({ user_id }) => {
    if (user_id === excludeUserId) return;
    getConn(user_id).forEach(ws => { if (ws.readyState === 1) ws.send(JSON.stringify(payload)); });
  });
}

function sendTo(userId, payload) {
  getConn(userId).forEach(ws => { if (ws.readyState === 1) ws.send(JSON.stringify(payload)); });
}

function getStatus(userId) { return userStatus.get(userId) || 'offline'; }

// Агрегированный статус пользователя по всем его устройствам:
// online, если хоть одно устройство активно; иначе away, если есть «отошедшее»; иначе offline.
// Это убирает «мигание» статуса, когда одно устройство уходит в фон, а другое активно.
function computeStatus(userId) {
  const conns = clients.get(userId);
  if (!conns || !conns.size) return 'offline';
  let anyAway = false;
  for (const ws of conns) {
    if (ws.readyState !== 1) continue;
    if (ws._status === 'online') return 'online';
    if (ws._status === 'away') anyAway = true;
  }
  return anyAway ? 'away' : 'offline';
}

// Пересчитать агрегат и разослать собеседникам ТОЛЬКО при реальном изменении статуса.
function broadcastStatus(userId) {
  const status = computeStatus(userId);
  if (userStatus.get(userId) === status) return; // не изменилось — не шумим
  userStatus.set(userId, status);
  const peers = db.prepare(`
    SELECT DISTINCT cm2.user_id FROM chat_members cm1
    JOIN chat_members cm2 ON cm2.chat_id = cm1.chat_id AND cm2.user_id != cm1.user_id
    JOIN chats c ON c.id = cm1.chat_id WHERE cm1.user_id = ? AND c.type = 'direct'
  `).all(userId).map(r => r.user_id);
  const payload = JSON.stringify({ type: 'presence', user_id: userId, status });
  peers.forEach(peerId => {
    getConn(peerId).forEach(ws => { if (ws.readyState === 1) ws.send(payload); });
  });
}

function getMessageWithStatus(msgId, viewerId) {
  const msg = db.prepare(`
    SELECT m.id, m.chat_id, m.text, m.sent_at, m.edited_at, m.deleted, m.attachment,
      u.id as sender_id, u.display_name as sender_name,
      m.reply_to_id,
      rm.text as reply_text, ru.display_name as reply_sender_name
    FROM messages m JOIN users u ON u.id = m.sender_id
    LEFT JOIN messages rm ON rm.id = m.reply_to_id
    LEFT JOIN users ru ON ru.id = rm.sender_id
    WHERE m.id = ?
  `).get(msgId);
  if (!msg) return null;
  if (msg.attachment) try { msg.attachment = JSON.parse(msg.attachment); } catch { msg.attachment = null; }

  const memberCount = db.prepare('SELECT COUNT(*) as c FROM chat_members WHERE chat_id = ? AND user_id != ?').get(msg.chat_id, msg.sender_id).c;
  const delivered = db.prepare('SELECT COUNT(*) as c FROM message_status WHERE message_id = ? AND delivered_at IS NOT NULL').get(msgId).c;
  const read = db.prepare('SELECT COUNT(*) as c FROM message_status WHERE message_id = ? AND read_at IS NOT NULL').get(msgId).c;

  return { ...msg, status: { delivered, read, total: memberCount } };
}

function setup(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Серверный heartbeat: отлавливаем «зомби»-сокеты (клиент пропал без TCP-close).
  // Без него пользователь остаётся «онлайн», а push ему не уходит.
  const heartbeat = setInterval(() => {
    wss.clients.forEach(ws => {
      if (ws.isAlive === false) { try { ws.terminate(); } catch {} return; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    });
  }, 30000);
  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    let user;
    try { user = wsAuth(url.searchParams.get('token')); } catch { ws.close(1008, 'Unauthorized'); return; }

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws._status = 'online'; // уточнится первым set_status от клиента (~через 300мс)

    if (!clients.has(user.id)) clients.set(user.id, new Set());
    clients.get(user.id).add(ws);
    broadcastStatus(user.id);

    const connId = ++connCounter;
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '—';
    connMeta.set(connId, { ws, userId: user.id, username: user.username, displayName: user.display_name, hostname: '—', clientVersion: '—', osPlatform: '—', osRelease: '—', installScope: null, connectedAt: Date.now(), clientIp });
    ws._connId = connId;

    ws.on('message', raw => {
      let data; try { data = JSON.parse(raw); } catch { return; }

      if (data.type === 'message') {
        const { chat_id, text, reply_to_id, attachment } = data;
        if (!chat_id || (!text?.trim() && !attachment)) return;
        if (!db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chat_id, user.id)) return;

        // Unhide chat for any members who had hidden it (e.g. deleted direct chat)
        const hidden = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? AND hidden_at IS NOT NULL').all(chat_id);
        if (hidden.length) {
          db.prepare('UPDATE chat_members SET hidden_at = NULL WHERE chat_id = ? AND hidden_at IS NOT NULL').run(chat_id);
          hidden.forEach(({ user_id }) => sendTo(user_id, { type: 'reload_chats' }));
        }

        const attJson = attachment ? JSON.stringify(attachment) : null;

        // Подготавливаем стейтменты вне транзакции — db.prepare нельзя вызывать внутри неё
        const stmtInsertMsg = db.prepare('INSERT INTO messages (chat_id, sender_id, text, reply_to_id, attachment) VALUES (?, ?, ?, ?, ?)');
        const stmtGetMembers = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?');
        const stmtInsStatus = db.prepare('INSERT OR IGNORE INTO message_status (message_id, user_id) VALUES (?, ?)');
        const stmtUpdDelivered = db.prepare('UPDATE message_status SET delivered_at = COALESCE(delivered_at, unixepoch()) WHERE message_id = ? AND user_id = ?');

        // Вставка сообщения и статусов доставки в одной транзакции
        const msgId = db.transaction(() => {
          const result = stmtInsertMsg.run(chat_id, user.id, (text||'').trim(), reply_to_id || null, attJson);
          const newMsgId = result.lastInsertRowid;
          // Пометить как delivered тем участникам, которые сейчас онлайн (кроме отправителя)
          const members = stmtGetMembers.all(chat_id, user.id);
          members.forEach(({ user_id }) => {
            if (clients.has(user_id) && clients.get(user_id).size > 0) {
              stmtInsStatus.run(newMsgId, user_id);
              stmtUpdDelivered.run(newMsgId, user_id);
            }
          });
          return newMsgId;
        })();

        const msg = getMessageWithStatus(msgId, user.id);
        broadcast(chat_id, { type: 'message', message: msg });

        // Push-уведомления офлайн-участникам (нет активного WS-соединения)
        const chat = db.prepare('SELECT type, name FROM chats WHERE id = ?').get(chat_id);
        const allMembers = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?').all(chat_id, user.id);
        allMembers.forEach(({ user_id }) => {
          const isOnline = clients.has(user_id) && clients.get(user_id).size > 0;
          if (!isOnline) {
            const chatTitle = chat?.type === 'direct' ? msg.sender_name : (chat?.name || 'Electron');
            // Всего непрочитанных у получателя — для счётчика на иконке PWA
            const unread = db.prepare(`
              SELECT COUNT(*) AS c FROM messages m
              JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
              LEFT JOIN message_status ms ON ms.message_id = m.id AND ms.user_id = ?
              WHERE m.sender_id != ? AND m.deleted = 0 AND ms.read_at IS NULL
            `).get(user_id, user_id, user_id).c;
            pushToUser(user_id, {
              title: chatTitle,
              body: msg.text || (msg.attachment ? '🖼 Изображение' : ''),
              chatId: chat_id,
              unread,
            });
          }
        });
      }

      if (data.type === 'delivered') {
        const { message_id } = data;
        const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(message_id);
        if (!msg || msg.sender_id === user.id) return;
        db.prepare('INSERT OR IGNORE INTO message_status (message_id, user_id) VALUES (?, ?)').run(message_id, user.id);
        db.prepare('UPDATE message_status SET delivered_at = unixepoch() WHERE message_id = ? AND user_id = ? AND delivered_at IS NULL').run(message_id, user.id);
        const updated = getMessageWithStatus(message_id, msg.sender_id);
        sendTo(msg.sender_id, { type: 'status_update', message: updated });
      }

      if (data.type === 'read') {
        const { chat_id } = data;
        if (!db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chat_id, user.id)) return;
        const unread = db.prepare('SELECT id, sender_id FROM messages WHERE chat_id = ? AND sender_id != ? AND deleted = 0').all(chat_id, user.id);
        // Подготавливаем стейтменты вне транзакции
        const stmtReadInsert = db.prepare('INSERT OR IGNORE INTO message_status (message_id, user_id) VALUES (?, ?)');
        const stmtReadUpdate = db.prepare('UPDATE message_status SET delivered_at = COALESCE(delivered_at, unixepoch()), read_at = COALESCE(read_at, unixepoch()) WHERE message_id = ? AND user_id = ?');
        const senders = new Set();
        // Обновляем статусы всех непрочитанных сообщений в одной транзакции
        db.transaction(() => {
          unread.forEach(({ id, sender_id }) => { stmtReadInsert.run(id, user.id); stmtReadUpdate.run(id, user.id); senders.add(sender_id); });
        })();
        senders.forEach(senderId => {
          const msgs = db.prepare('SELECT id FROM messages WHERE chat_id = ? AND sender_id = ?').all(chat_id, senderId);
          msgs.forEach(({ id }) => { const m = getMessageWithStatus(id, senderId); if (m) sendTo(senderId, { type: 'status_update', message: m }); });
        });
        // Синхронизация прочтения между устройствами самого пользователя
        getConn(user.id).forEach(w => { if (w !== ws && w.readyState === 1) w.send(JSON.stringify({ type: 'chat_read', chat_id })); });
      }

      if (data.type === 'edit_message') {
        const { message_id, text } = data;
        if (!text?.trim()) return;
        const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND deleted = 0').get(message_id);
        if (!msg || msg.sender_id !== user.id) return;
        if (Date.now() / 1000 - msg.sent_at > 120) { // 2 min limit
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'edit_rejected', message_id, reason: 'time' }));
          return;
        }
        db.prepare('UPDATE messages SET text = ?, edited_at = unixepoch() WHERE id = ?').run(text.trim(), message_id);
        const updated = getMessageWithStatus(message_id, user.id);
        broadcast(msg.chat_id, { type: 'message_edited', message: updated });
      }

      if (data.type === 'delete_message') {
        const { message_id } = data;
        const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND deleted = 0').get(message_id);
        if (!msg || msg.sender_id !== user.id) return;
        deleteAttachmentFile(msg.attachment);
        db.prepare("UPDATE messages SET deleted = 1, text = '', attachment = NULL WHERE id = ?").run(message_id);
        broadcast(msg.chat_id, { type: 'message_deleted', message_id, chat_id: msg.chat_id });
      }

      if (data.type === 'set_status') {
        const s = data.status;
        if (s === 'online' || s === 'away') { ws._status = s; broadcastStatus(user.id); }
      }

      if (data.type === 'react') {
        const { message_id, reaction } = data;
        if (!['👍','👎','❤️','😂'].includes(reaction)) return;
        const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND deleted = 0').get(message_id);
        if (!msg) return;
        if (!db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(msg.chat_id, user.id)) return;
        const existing = db.prepare('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND reaction = ?').get(message_id, user.id, reaction);
        if (existing) {
          db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND reaction = ?').run(message_id, user.id, reaction);
        } else {
          db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, reaction) VALUES (?, ?, ?)').run(message_id, user.id, reaction);
        }
        const counts = db.prepare('SELECT reaction, COUNT(*) as count FROM reactions WHERE message_id = ? GROUP BY reaction').all(message_id);
        broadcast(msg.chat_id, { type: 'reaction_update', message_id, counts });
      }

      if (data.type === 'typing') {
        const { chat_id } = data;
        if (!db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chat_id, user.id)) return;
        broadcast(chat_id, { type: 'typing', chat_id, user_id: user.id, sender_name: user.display_name }, user.id);
      }

      if (data.type === 'client_info') {
        const meta = connMeta.get(ws._connId);
        if (meta) { meta.hostname = data.hostname || '—'; meta.clientVersion = data.clientVersion || '—'; meta.osPlatform = data.osPlatform || '—'; meta.osRelease = data.osRelease || '—'; meta.installScope = data.installScope || null; }
      }

      if (data.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    });

    ws.on('close', () => {
      connMeta.delete(ws._connId);
      const conns = clients.get(user.id);
      if (conns) {
        conns.delete(ws);
        if (!conns.size) clients.delete(user.id);
      }
      // Пересчитываем агрегат: если осталось активное устройство — статус не упадёт в offline.
      broadcastStatus(user.id);
    });

    ws.send(JSON.stringify({ type: 'connected', user_id: user.id }));

    // Авто-доставка при подключении: безопасно, после регистрации всех обработчиков
    setImmediate(() => {
      try {
        const undelivered = db.prepare(`
          SELECT m.id, m.sender_id FROM messages m
          JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
          LEFT JOIN message_status ms ON ms.message_id = m.id AND ms.user_id = ?
          WHERE m.sender_id != ? AND m.deleted = 0 AND ms.delivered_at IS NULL
        `).all(user.id, user.id, user.id);
        if (!undelivered.length) return;
        const ins = db.prepare('INSERT OR IGNORE INTO message_status (message_id, user_id) VALUES (?, ?)');
        const upd = db.prepare('UPDATE message_status SET delivered_at = unixepoch() WHERE message_id = ? AND user_id = ? AND delivered_at IS NULL');
        const senders = new Set();
        undelivered.forEach(({ id, sender_id }) => { ins.run(id, user.id); upd.run(id, user.id); senders.add(sender_id); });
        const getMsgs = db.prepare('SELECT id FROM messages WHERE chat_id IN (SELECT chat_id FROM chat_members WHERE user_id = ?) AND sender_id = ? AND deleted = 0');
        senders.forEach(senderId => {
          getMsgs.all(user.id, senderId).forEach(({ id }) => {
            const m = getMessageWithStatus(id, senderId);
            if (m) sendTo(senderId, { type: 'status_update', message: m });
          });
        });
      } catch (e) { console.error('auto-deliver error:', e); }
    });
  });
}

function getClients() {
  return Array.from(connMeta.values()).map(m => ({
    connId: m.ws._connId,
    userId: m.userId,
    username: m.username,
    displayName: m.displayName,
    hostname: m.hostname,
    clientVersion: m.clientVersion,
    osPlatform: m.osPlatform,
    osRelease: m.osRelease,
    installScope: m.installScope,
    connectedAt: m.connectedAt,
    clientIp: m.clientIp,
    status: userStatus.get(m.userId) || 'online',
  }));
}

function sendToConn(connId, payload) {
  const meta = connMeta.get(connId);
  if (meta && meta.ws.readyState === 1) meta.ws.send(JSON.stringify(payload));
}

function getConnCount() { return connMeta.size; }

module.exports = { setup, broadcast, sendTo, getStatus, getClients, sendToConn, getConnCount };
