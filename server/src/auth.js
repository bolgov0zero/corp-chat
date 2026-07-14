const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('./db');

// Секрет: env → settings → генерируем и сохраняем при первом старте.
// Захардкоженный дефолт позволял любому, кто видел исходники, подделать токен админа.
function getSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get();
  if (row) return row.value;
  const secret = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('jwt_secret', secret);
  console.log('[Auth] Сгенерирован новый JWT-секрет (сохранён в settings). Все существующие сессии сброшены.');
  return secret;
}

const SECRET = getSecret();
const EXPIRES_IN = '7d';

function signToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN });
}

function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

// Сверяем пользователя с БД на каждый запрос: удалённый пользователь или
// разжалованный админ теряет доступ сразу, а не когда истечёт 7-дневный токен.
// Заодно display_name/is_admin всегда актуальны, а не заморожены в токене.
function resolveUser(token) {
  const payload = verifyToken(token);
  const user = db.prepare('SELECT id, username, display_name, is_admin FROM users WHERE id = ?').get(payload.id);
  if (!user) return null;
  return { ...user, is_admin: !!user.is_admin };
}

function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: 'No token' });
  const token = header.replace('Bearer ', '');
  try {
    const user = resolveUser(token);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function adminMiddleware(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Forbidden' });
  next();
}

function wsAuth(token) {
  const user = resolveUser(token);
  if (!user) throw new Error('User not found');
  return user;
}

module.exports = { signToken, verifyToken, authMiddleware, adminMiddleware, wsAuth };
