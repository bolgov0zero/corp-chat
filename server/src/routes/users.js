const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authMiddleware, adminMiddleware } = require('../auth');

// List all users (for starting chats)
router.get('/', authMiddleware, (req, res) => {
  const users = db.prepare('SELECT id, username, display_name FROM users WHERE id != ? ORDER BY display_name').all(req.user.id);
  res.json(users);
});

// Admin: create user
router.post('/', authMiddleware, adminMiddleware, (req, res) => {
  const { username, password, display_name, is_admin } = req.body;
  if (!username?.trim() || !password || !display_name?.trim()) return res.status(400).json({ error: 'Missing fields' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare('INSERT INTO users (username, password_hash, display_name, is_admin) VALUES (?, ?, ?, ?)')
      .run(username.trim(), hash, display_name.trim(), is_admin ? 1 : 0);
    res.json({ id: result.lastInsertRowid, username, display_name, is_admin: !!is_admin });
  } catch { res.status(409).json({ error: 'Username already exists' }); }
});

// Admin: edit user
router.patch('/:id', authMiddleware, adminMiddleware, (req, res) => {
  const { username, display_name, is_admin } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  try {
    db.prepare('UPDATE users SET username = ?, display_name = ?, is_admin = ? WHERE id = ?')
      .run(username?.trim() || user.username, display_name?.trim() || user.display_name, is_admin !== undefined ? (is_admin ? 1 : 0) : user.is_admin, req.params.id);
    res.json({ ok: true });
  } catch { res.status(409).json({ error: 'Username already exists' }); }
});

// Admin: change password
router.patch('/:id/password', authMiddleware, adminMiddleware, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Missing password' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.params.id);
  res.json({ ok: true });
});

// Admin: delete user
router.delete('/:id', authMiddleware, adminMiddleware, (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
