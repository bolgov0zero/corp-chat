const http = require('http');
const express = require('express');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'chat_db', 'chat.db');
const FILES_DIR = path.join(path.dirname(DB_PATH), 'files');

const app = express();
const server = http.createServer(app);

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));
app.use('/files', express.static(FILES_DIR));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/chats', require('./routes/chats'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/upload', require('./routes/upload'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/push',  require('./routes/push'));

require('./ws').setup(server);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Electron server running on http://0.0.0.0:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin`);
});
