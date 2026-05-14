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

module.exports = router;
