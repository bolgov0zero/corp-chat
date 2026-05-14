const { WebSocketServer } = require('ws');
const db = require('./db');
const { wsAuth } = require('./auth');

// Map: userId -> Set of ws connections
const clients = new Map();

function broadcast(chatId, message) {
  const members = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId);
  members.forEach(({ user_id }) => {
    const conns = clients.get(user_id);
    if (!conns) return;
    conns.forEach(ws => {
      if (ws.readyState === 1) ws.send(JSON.stringify(message));
    });
  });
}

function setup(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');

    let user;
    try {
      user = wsAuth(token);
    } catch {
      ws.close(1008, 'Unauthorized');
      return;
    }

    if (!clients.has(user.id)) clients.set(user.id, new Set());
    clients.get(user.id).add(ws);

    ws.on('message', raw => {
      let data;
      try { data = JSON.parse(raw); } catch { return; }

      if (data.type === 'message') {
        const { chat_id, text } = data;
        if (!chat_id || !text?.trim()) return;

        const member = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chat_id, user.id);
        if (!member) return;

        const result = db.prepare('INSERT INTO messages (chat_id, sender_id, text) VALUES (?, ?, ?)').run(chat_id, user.id, text.trim());
        const msg = db.prepare(`
          SELECT m.id, m.text, m.sent_at, u.id as sender_id, u.display_name as sender_name
          FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?
        `).get(result.lastInsertRowid);

        broadcast(chat_id, { type: 'message', chat_id, message: msg });
      }

      if (data.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    });

    ws.on('close', () => {
      const conns = clients.get(user.id);
      if (conns) { conns.delete(ws); if (conns.size === 0) clients.delete(user.id); }
    });

    ws.send(JSON.stringify({ type: 'connected', user_id: user.id }));
  });
}

module.exports = { setup, broadcast };
