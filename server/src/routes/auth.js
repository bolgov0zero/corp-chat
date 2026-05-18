const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken } = require('../auth');

// In-memory rate limiter для /login: ip -> { count, resetAt }
const loginAttempts = new Map();
const RATE_LIMIT = 10;       // максимум попыток
const RATE_WINDOW = 60_000; // окно сброса в мс (60 сек)

function getRateLimitKey(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;
}

function checkRateLimit(req) {
  const key = getRateLimitKey(req);
  const now = Date.now();
  const entry = loginAttempts.get(key);

  if (entry && now > entry.resetAt) {
    // Окно истекло — сбрасываем счётчик
    loginAttempts.delete(key);
  }

  const current = loginAttempts.get(key);
  if (current && current.count >= RATE_LIMIT) return false;

  if (current) {
    current.count++;
  } else {
    loginAttempts.set(key, { count: 1, resetAt: now + RATE_WINDOW });
  }
  return true;
}

router.post('/login', (req, res) => {
  // Проверяем rate limit перед обработкой запроса
  if (!checkRateLimit(req)) {
    return res.status(429).json({ error: 'Too many attempts, try again later' });
  }

  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Invalid credentials' });

  const token = signToken({ id: user.id, username: user.username, display_name: user.display_name, is_admin: !!user.is_admin });
  res.json({ token, user: { id: user.id, username: user.username, display_name: user.display_name, is_admin: !!user.is_admin } });
});

router.get('/me', (req, res) => {
  const auth = req.headers.authorization?.split(' ')[1];
  if (!auth) return res.status(401).json({ error: 'No token' });
  try {
    const { verifyToken } = require('../auth');
    const payload = verifyToken(auth);
    const user = db.prepare('SELECT id, username, display_name, is_admin FROM users WHERE id = ?').get(payload.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    res.json({ ...user, is_admin: !!user.is_admin });
  } catch { res.status(401).json({ error: 'Invalid token' }); }
});

module.exports = router;
