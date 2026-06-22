'use strict';

const router = require('express').Router();
const webpush = require('web-push');
const db = require('../db');
const { authMiddleware } = require('../auth');

// ── VAPID ключи: генерируем один раз, храним в settings ──
function getOrCreateVapidKeys() {
  const pubRow  = db.prepare("SELECT value FROM settings WHERE key = 'vapid_public'").get();
  const privRow = db.prepare("SELECT value FROM settings WHERE key = 'vapid_private'").get();
  if (pubRow && privRow) {
    return { publicKey: pubRow.value, privateKey: privRow.value };
  }
  const keys = webpush.generateVAPIDKeys();
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  upsert.run('vapid_public',  keys.publicKey);
  upsert.run('vapid_private', keys.privateKey);
  return keys;
}

const VAPID_CONTACT = 'mailto:bolgov@me.com';

const vapidKeys = getOrCreateVapidKeys();

// Если контакт сменился — все старые подписки невалидны, сбрасываем
const savedContact = db.prepare("SELECT value FROM settings WHERE key = 'vapid_contact'").get()?.value;
if (savedContact !== VAPID_CONTACT) {
  db.prepare('DELETE FROM push_subscriptions').run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('vapid_contact', ?)").run(VAPID_CONTACT);
}

webpush.setVapidDetails(VAPID_CONTACT, vapidKeys.publicKey, vapidKeys.privateKey);

// Экспортируем для использования в ws.js
function sendPushToUser(userId, payload) {
  const subs = db.prepare('SELECT endpoint, keys FROM push_subscriptions WHERE user_id = ?').all(userId);
  subs.forEach(row => {
    const sub = { endpoint: row.endpoint, keys: JSON.parse(row.keys) };
    webpush.sendNotification(sub, JSON.stringify(payload)).catch(err => {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Подписка истекла на стороне браузера — удаляем
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(row.endpoint);
      } else {
        console.error('[Push] sendNotification failed:', err.statusCode, err.message, row.endpoint.slice(0, 60));
      }
    });
  });
}

// ── ROUTES ──

// Публичный VAPID-ключ (без авторизации — нужен до входа для SW)
router.get('/vapid-public-key', (req, res) => {
  res.json({ key: vapidKeys.publicKey });
});

router.use(authMiddleware);

// Сохранить подписку
router.post('/subscribe', (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, keys)
    VALUES (?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys
  `).run(req.user.id, endpoint, JSON.stringify(keys));
  res.json({ ok: true });
});

// Удалить подписку
router.delete('/subscribe', (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, req.user.id);
  }
  res.json({ ok: true });
});

// Список всех подписок (только для администраторов)
router.get('/subscriptions', (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Forbidden' });
  const rows = db.prepare(`
    SELECT ps.id, ps.user_id, ps.endpoint, ps.created_at,
      u.username, u.display_name
    FROM push_subscriptions ps
    JOIN users u ON u.id = ps.user_id
    ORDER BY ps.created_at DESC
  `).all();
  res.json(rows);
});

// Удаление подписки администратором по id
router.delete('/subscriptions/:id', (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Диагностика: тестовый push конкретному пользователю (только для администраторов)
router.post('/test/:userId', async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Forbidden' });
  const targetId = Number(req.params.userId);
  const subs = db.prepare('SELECT endpoint, keys FROM push_subscriptions WHERE user_id = ?').all(targetId);
  if (!subs.length) return res.status(404).json({ error: 'Нет подписок для этого пользователя' });

  const results = await Promise.all(subs.map(async row => {
    const sub = { endpoint: row.endpoint, keys: JSON.parse(row.keys) };
    const service = (() => { try { return new URL(row.endpoint).hostname; } catch { return row.endpoint.slice(0,40); } })();
    try {
      await webpush.sendNotification(sub, JSON.stringify({
        title: 'Тест уведомлений',
        body: 'Push-уведомления работают корректно.',
        chatId: null,
      }));
      return { service, ok: true };
    } catch (err) {
      const code = err.statusCode || err.code || '?';
      const msg  = err.body || err.message || String(err);
      console.error('[Push] test failed:', code, msg, row.endpoint.slice(0, 60));
      // 410/404 — подписка устарела, чистим
      if (err.statusCode === 410 || err.statusCode === 404) {
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(row.endpoint);
      }
      return { service, ok: false, code, error: msg.slice(0, 200) };
    }
  }));

  const allOk = results.every(r => r.ok);
  res.status(allOk ? 200 : 207).json({ results });
});

module.exports = router;
module.exports.sendPushToUser = sendPushToUser;
module.exports.getVapidPublicKey = () => vapidKeys.publicKey;
