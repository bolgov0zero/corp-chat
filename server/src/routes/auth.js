const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken } = require('../auth');

router.post('/login', (req, res) => {
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
