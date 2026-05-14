const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'chat.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('direct', 'group')),
    name TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS chat_members (
    chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    joined_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (chat_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
    sender_id INTEGER REFERENCES users(id),
    text TEXT NOT NULL,
    edited_at INTEGER,
    deleted INTEGER DEFAULT 0,
    sent_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS message_status (
    message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    delivered_at INTEGER,
    read_at INTEGER,
    PRIMARY KEY (message_id, user_id)
  );
`);

// Add columns if upgrading from old schema
const tryAlter = (sql) => { try { db.exec(sql); } catch {} };
tryAlter('ALTER TABLE messages ADD COLUMN edited_at INTEGER');
tryAlter('ALTER TABLE messages ADD COLUMN deleted INTEGER DEFAULT 0');

// Default admin
const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get();
if (userCount.c === 0) {
  const hash = bcrypt.hashSync('admin', 10);
  db.prepare('INSERT INTO users (username, password_hash, display_name, is_admin) VALUES (?, ?, ?, 1)')
    .run('admin', hash, 'Administrator');
  console.log('Created default admin: admin / admin');
}

module.exports = db;
