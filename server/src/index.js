const http = require('http');
const express = require('express');
const path = require('path');

const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/chats', require('./routes/chats'));
app.use('/api/admin', require('./routes/admin'));

require('./ws').setup(server);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Corp Chat server running on http://0.0.0.0:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin`);
});
