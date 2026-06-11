const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'chat_db', 'chat.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.pragma('cache_size = -8000'); // 8 MB page cache

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
    type TEXT NOT NULL CHECK(type IN ('direct', 'group', 'room')),
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

  CREATE TABLE IF NOT EXISTS reactions (
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    reaction TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id, reaction),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_chat_sent    ON messages(chat_id, sent_at);
  CREATE INDEX IF NOT EXISTS idx_chat_members_user     ON chat_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_chat_members_chat     ON chat_members(chat_id);
  CREATE INDEX IF NOT EXISTS idx_message_status_msg    ON message_status(message_id);
  CREATE INDEX IF NOT EXISTS idx_reactions_msg         ON reactions(message_id);

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT UNIQUE NOT NULL,
    keys TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
`);

fs.mkdirSync(path.join(path.dirname(DB_PATH), 'avatar'), { recursive: true });
fs.mkdirSync(path.join(path.dirname(DB_PATH), 'files'), { recursive: true });

// Add columns if upgrading from old schema
const tryAlter = (sql) => { try { db.exec(sql); } catch {} };
tryAlter('ALTER TABLE messages ADD COLUMN edited_at INTEGER');
tryAlter('ALTER TABLE messages ADD COLUMN deleted INTEGER DEFAULT 0');
tryAlter('ALTER TABLE chat_members ADD COLUMN hidden_at INTEGER');
tryAlter('ALTER TABLE messages ADD COLUMN reply_to_id INTEGER REFERENCES messages(id)');
tryAlter('ALTER TABLE messages ADD COLUMN attachment TEXT');
tryAlter('ALTER TABLE users ADD COLUMN tag TEXT DEFAULT NULL');

// Default admin
const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get();
if (userCount.c === 0) {
  const hash = bcrypt.hashSync('admin', 10);
  db.prepare('INSERT INTO users (username, password_hash, display_name, is_admin) VALUES (?, ?, ?, 1)')
    .run('admin', hash, 'Administrator');
  console.log('Created default admin: admin / admin');
}

// Periodically let SQLite tune its own query planner stats (safe, read-only analysis)
db.pragma('optimize');
setInterval(() => db.pragma('optimize'), 3_600_000); // every hour

module.exports = db;
