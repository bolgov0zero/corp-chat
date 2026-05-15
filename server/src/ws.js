const { WebSocketServer } = require('ws');
const db = require('./db');
const { wsAuth } = require('./auth');

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

// Broadcast status change to all users who share a direct chat with this user
function broadcastStatus(userId, status) {
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
    SELECT m.id, m.chat_id, m.text, m.sent_at, m.edited_at, m.deleted,
      u.id as sender_id, u.display_name as sender_name,
      m.reply_to_id,
      rm.text as reply_text, ru.display_name as reply_sender_name
    FROM messages m JOIN users u ON u.id = m.sender_id
    LEFT JOIN messages rm ON rm.id = m.reply_to_id
    LEFT JOIN users ru ON ru.id = rm.sender_id
    WHERE m.id = ?
  `).get(msgId);
  if (!msg) return null;

  const chat = db.prepare('SELECT type FROM chats WHERE id = ?').get(msg.chat_id);
  const memberCount = db.prepare('SELECT COUNT(*) as c FROM chat_members WHERE chat_id = ? AND user_id != ?').get(msg.chat_id, msg.sender_id).c;
  const delivered = db.prepare('SELECT COUNT(*) as c FROM message_status WHERE message_id = ? AND delivered_at IS NOT NULL').get(msgId).c;
  const read = db.prepare('SELECT COUNT(*) as c FROM message_status WHERE message_id = ? AND read_at IS NOT NULL').get(msgId).c;

  return { ...msg, status: { delivered, read, total: memberCount } };
}

function setup(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    let user;
    try { user = wsAuth(url.searchParams.get('token')); } catch { ws.close(1008, 'Unauthorized'); return; }

    if (!clients.has(user.id)) clients.set(user.id, new Set());
    clients.get(user.id).add(ws);
    broadcastStatus(user.id, 'online');
    const connId = ++connCounter;
    connMeta.set(connId, { ws, userId: user.id, username: user.username, displayName: user.display_name, hostname: '—', clientVersion: '—', osPlatform: '—', osRelease: '—', connectedAt: Date.now() });
    ws._connId = connId;

    ws.on('message', raw => {
      let data; try { data = JSON.parse(raw); } catch { return; }

      if (data.type === 'message') {
        const { chat_id, text, reply_to_id } = data;
        if (!chat_id || !text?.trim()) return;
        if (!db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chat_id, user.id)) return;

        // Unhide chat for any members who had hidden it (e.g. deleted direct chat)
        const hidden = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? AND hidden_at IS NOT NULL').all(chat_id);
        if (hidden.length) {
          db.prepare('UPDATE chat_members SET hidden_at = NULL WHERE chat_id = ? AND hidden_at IS NOT NULL').run(chat_id);
          hidden.forEach(({ user_id }) => sendTo(user_id, { type: 'reload_chats' }));
        }

        const result = db.prepare('INSERT INTO messages (chat_id, sender_id, text, reply_to_id) VALUES (?, ?, ?, ?)').run(chat_id, user.id, text.trim(), reply_to_id || null);
        const msg = getMessageWithStatus(result.lastInsertRowid, user.id);
        broadcast(chat_id, { type: 'message', message: msg });
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
        const insert = db.prepare('INSERT OR IGNORE INTO message_status (message_id, user_id) VALUES (?, ?)');
        const update = db.prepare('UPDATE message_status SET delivered_at = COALESCE(delivered_at, unixepoch()), read_at = COALESCE(read_at, unixepoch()) WHERE message_id = ? AND user_id = ?');
        const senders = new Set();
        unread.forEach(({ id, sender_id }) => { insert.run(id, user.id); update.run(id, user.id); senders.add(sender_id); });
        senders.forEach(senderId => {
          const msgs = db.prepare('SELECT id FROM messages WHERE chat_id = ? AND sender_id = ?').all(chat_id, senderId);
          msgs.forEach(({ id }) => { const m = getMessageWithStatus(id, senderId); if (m) sendTo(senderId, { type: 'status_update', message: m }); });
        });
      }

      if (data.type === 'edit_message') {
        const { message_id, text } = data;
        if (!text?.trim()) return;
        const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND deleted = 0').get(message_id);
        if (!msg || msg.sender_id !== user.id) return;
        if (Date.now() / 1000 - msg.sent_at > 120) return; // 2 min limit
        db.prepare('UPDATE messages SET text = ?, edited_at = unixepoch() WHERE id = ?').run(text.trim(), message_id);
        const updated = getMessageWithStatus(message_id, user.id);
        broadcast(msg.chat_id, { type: 'message_edited', message: updated });
      }

      if (data.type === 'delete_message') {
        const { message_id } = data;
        const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND deleted = 0').get(message_id);
        if (!msg || msg.sender_id !== user.id) return;
        db.prepare("UPDATE messages SET deleted = 1, text = '' WHERE id = ?").run(message_id);
        broadcast(msg.chat_id, { type: 'message_deleted', message_id, chat_id: msg.chat_id });
      }

      if (data.type === 'set_status') {
        const s = data.status;
        if (s === 'online' || s === 'away') broadcastStatus(user.id, s);
      }

      if (data.type === 'react') {
        const { message_id, reaction } = data;
        if (!['👍','👎'].includes(reaction)) return;
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
        if (meta) { meta.hostname = data.hostname || '—'; meta.clientVersion = data.clientVersion || '—'; meta.osPlatform = data.osPlatform || '—'; meta.osRelease = data.osRelease || '—'; }
      }

      if (data.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    });

    ws.on('close', () => {
      connMeta.delete(ws._connId);
      const conns = clients.get(user.id);
      if (conns) {
        conns.delete(ws);
        if (!conns.size) { clients.delete(user.id); broadcastStatus(user.id, 'offline'); }
      }
    });

    ws.send(JSON.stringify({ type: 'connected', user_id: user.id }));
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
    connectedAt: m.connectedAt,
    status: userStatus.get(m.userId) || 'online',
  }));
}

function sendToConn(connId, payload) {
  const meta = connMeta.get(connId);
  if (meta && meta.ws.readyState === 1) meta.ws.send(JSON.stringify(payload));
}

module.exports = { setup, broadcast, sendTo, getStatus, getClients, sendToConn };
