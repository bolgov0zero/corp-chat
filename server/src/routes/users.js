const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authMiddleware, adminMiddleware } = require('../auth');

// Get all users (for starting chats)
router.get('/', authMiddleware, (req, res) => {
  const users = db.prepare('SELECT id, username, display_name FROM users WHERE id != ?').all(req.user.id);
  res.json(users);
});

// Admin: create user
router.post('/', authMiddleware, adminMiddleware, (req, res) => {
  const { username, password, display_name, is_admin } = req.body;
  if (!username || !password || !display_name) return res.status(400).json({ error: 'Missing fields' });
  const hash = bcrypt.hashSync(password, 10);
  try {
    const result = db.prepare('INSERT INTO users (username, password_hash, display_name, is_admin) VALUES (?, ?, ?, ?)')
      .run(username, hash, display_name, is_admin ? 1 : 0);
    res.json({ id: result.lastInsertRowid, username, display_name });
  } catch (e) {
    res.status(409).json({ error: 'Username already exists' });
  }
});

// Admin: delete user
router.delete('/:id', authMiddleware, adminMiddleware, (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Admin: change password
router.patch('/:id/password', authMiddleware, adminMiddleware, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Missing password' });
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.params.id);
  res.json({ ok: true });
});

module.exports = router;
