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
      // 410 Gone — подписка истекла, удаляем
      if (err.statusCode === 410 || err.statusCode === 404) {
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(row.endpoint);
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

module.exports = router;
module.exports.sendPushToUser = sendPushToUser;
module.exports.getVapidPublicKey = () => vapidKeys.publicKey;
