// State
let state = {
  server: '',
  token: null,
  user: null,
  chats: [],
  activeChatId: null,
  ws: null,
  unread: {},       // chatId -> count
  allUsers: []
};

// Persist login
const STORAGE_KEY = 'corp_chat_session';

function saveSession() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ server: state.server, token: state.token, user: state.user }));
}

function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (s?.token && s?.server) return s;
  } catch {}
  return null;
}

// API helper
async function api(method, path, body) {
  const res = await fetch(`http://${state.server}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) { logout(); return null; }
  return res.json();
}

// Init
window.addEventListener('DOMContentLoaded', () => {
  const session = loadSession();
  if (session) {
    state.server = session.server;
    state.token = session.token;
    state.user = session.user;
    enterApp();
  }
  document.getElementById('l-password').addEventListener('keydown', e => e.key === 'Enter' && doLogin());
  document.getElementById('l-server').addEventListener('keydown', e => e.key === 'Enter' && document.getElementById('l-username').focus());
});

async function doLogin() {
  const server = document.getElementById('l-server').value.trim().replace(/^https?:\/\//, '');
  const username = document.getElementById('l-username').value.trim();
  const password = document.getElementById('l-password').value;
  const errEl = document.getElementById('l-err');
  const btn = document.getElementById('l-btn');

  if (!server || !username || !password) { errEl.textContent = 'Заполните все поля'; return; }

  btn.disabled = true; btn.textContent = 'Подключение...'; errEl.textContent = '';

  try {
    const res = await fetch(`http://${server}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (data.token) {
      state.server = server;
      state.token = data.token;
      state.user = data.user;
      saveSession();
      enterApp();
    } else {
      errEl.textContent = data.error || 'Ошибка входа';
    }
  } catch (e) {
    errEl.textContent = 'Не удалось подключиться к серверу';
  } finally {
    btn.disabled = false; btn.textContent = 'Войти';
  }
}

function logout() {
  if (state.ws) state.ws.close();
  localStorage.removeItem(STORAGE_KEY);
  state = { server: '', token: null, user: null, chats: [], activeChatId: null, ws: null, unread: {}, allUsers: [] };
  showScreen('login');
}

function enterApp() {
  document.getElementById('my-name').textContent = state.user.display_name;
  document.getElementById('my-avatar').textContent = initials(state.user.display_name);
  showScreen('main');
  loadChats();
  loadUsers();
  connectWS();
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
}

// Chats
async function loadChats() {
  const chats = await api('GET', '/chats');
  if (!chats) return;
  state.chats = chats;
  renderChatList();
}

function renderChatList() {
  const search = document.getElementById('search').value.toLowerCase();
  const list = document.getElementById('chats-list');
  const filtered = state.chats.filter(c => chatDisplayName(c).toLowerCase().includes(search));
  list.innerHTML = filtered.map(c => {
    const name = chatDisplayName(c);
    const unread = state.unread[c.id] || 0;
    const preview = c.last_message ? c.last_message.text : 'Нет сообщений';
    const isActive = c.id === state.activeChatId;
    return `<div class="chat-item${isActive ? ' active' : ''}" onclick="openChat(${c.id})">
      <div class="avatar${c.type === 'group' ? ' green' : ''}">${initials(name)}</div>
      <div class="info">
        <div class="name">${esc(name)}</div>
        <div class="preview">${esc(preview)}</div>
      </div>
      ${unread > 0 ? `<div class="badge">${unread}</div>` : ''}
    </div>`;
  }).join('');
}

function filterChats() { renderChatList(); }

function chatDisplayName(chat) {
  if (chat.type === 'group') return chat.name || 'Группа';
  const other = chat.members?.find(m => m.id !== state.user.id);
  return other?.display_name || 'Чат';
}

// Open chat
async function openChat(chatId) {
  state.activeChatId = chatId;
  state.unread[chatId] = 0;
  updateUnreadBadge();
  renderChatList();

  const chat = state.chats.find(c => c.id === chatId);
  const name = chatDisplayName(chat);

  const area = document.getElementById('chat-area');
  area.innerHTML = `
    <div class="chat-header">
      <div class="avatar${chat.type === 'group' ? ' green' : ''}">${initials(name)}</div>
      <div class="chat-header-info">
        <div class="name">${esc(name)}</div>
        <div class="sub">${chat.type === 'group' ? `${chat.members?.length || 0} участников` : 'Личный чат'}</div>
      </div>
    </div>
    <div class="messages" id="messages"></div>
    <div class="chat-input-wrap">
      <textarea id="msg-input" placeholder="Сообщение..." rows="1" onkeydown="handleInputKey(event)" oninput="autoResize(this)"></textarea>
      <button class="send-btn" onclick="sendMessage()">➤</button>
    </div>
  `;

  const msgs = await api('GET', `/chats/${chatId}/messages`);
  if (msgs) renderMessages(msgs);
  document.getElementById('msg-input')?.focus();
}

function renderMessages(msgs) {
  const container = document.getElementById('messages');
  if (!container) return;
  container.innerHTML = msgs.map(m => {
    const mine = m.sender_id === state.user.id;
    const time = new Date(m.sent_at * 1000).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
    const chat = state.chats.find(c => c.id === state.activeChatId);
    const showSender = !mine && chat?.type === 'group';
    return `<div class="msg ${mine ? 'mine' : 'theirs'}">
      ${showSender ? `<div class="sender">${esc(m.sender_name)}</div>` : ''}
      <div class="bubble">${esc(m.text)}</div>
      <div class="time">${time}</div>
    </div>`;
  }).join('');
  container.scrollTop = container.scrollHeight;
}

function appendMessage(msg, chatId) {
  const mine = msg.sender_id === state.user.id;
  const time = new Date(msg.sent_at * 1000).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  const chat = state.chats.find(c => c.id === chatId);
  const showSender = !mine && chat?.type === 'group';
  const div = document.createElement('div');
  div.className = `msg ${mine ? 'mine' : 'theirs'}`;
  div.innerHTML = `
    ${showSender ? `<div class="sender">${esc(msg.sender_name)}</div>` : ''}
    <div class="bubble">${esc(msg.text)}</div>
    <div class="time">${time}</div>
  `;
  const container = document.getElementById('messages');
  if (container) { container.appendChild(div); container.scrollTop = container.scrollHeight; }
}

function handleInputKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function sendMessage() {
  const input = document.getElementById('msg-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text || !state.ws || state.ws.readyState !== 1) return;
  state.ws.send(JSON.stringify({ type: 'message', chat_id: state.activeChatId, text }));
  input.value = '';
  input.style.height = 'auto';
}

// WebSocket
function connectWS() {
  const ws = new WebSocket(`ws://${state.server}/ws?token=${state.token}`);
  state.ws = ws;

  ws.onmessage = e => {
    const data = JSON.parse(e.data);
    if (data.type === 'message') {
      const { chat_id, message } = data;

      // Update last message in chat list
      const chat = state.chats.find(c => c.id === chat_id);
      if (chat) { chat.last_message = message; } else { loadChats(); }

      if (state.activeChatId === chat_id) {
        appendMessage(message, chat_id);
      } else {
        // Unread
        state.unread[chat_id] = (state.unread[chat_id] || 0) + 1;
        updateUnreadBadge();

        // Native notification
        if (message.sender_id !== state.user.id) {
          const chatName = chat ? chatDisplayName(chat) : 'Чат';
          window.electron?.notify(chatName, message.sender_name + ': ' + message.text);
        }
      }
      renderChatList();
    }
  };

  ws.onclose = () => { setTimeout(() => { if (state.token) connectWS(); }, 3000); };
  ws.onerror = () => ws.close();
}

function updateUnreadBadge() {
  const total = Object.values(state.unread).reduce((a, b) => a + b, 0);
  window.electron?.setUnread(total);
}

// New chat modal
async function loadUsers() {
  const users = await api('GET', '/users');
  if (users) state.allUsers = users;
}

function openNewChat() {
  renderUsersList('users-list', false);
  renderUsersList('users-list-group', true);
  document.getElementById('modal-new-chat').classList.add('open');
}

function renderUsersList(containerId, multiSelect) {
  const container = document.getElementById(containerId);
  container.innerHTML = state.allUsers.map(u => `
    <div class="user-row" onclick="selectUser(this, ${u.id}, ${multiSelect})">
      <div class="avatar">${initials(u.display_name)}</div>
      <span>${esc(u.display_name)}</span>
    </div>
  `).join('');
}

async function selectUser(el, userId, multiSelect) {
  if (!multiSelect) {
    // Open direct chat immediately
    const data = await api('POST', '/chats/direct', { user_id: userId });
    if (data?.id) {
      closeModal('modal-new-chat');
      await loadChats();
      openChat(data.id);
    }
  } else {
    el.classList.toggle('selected');
  }
}

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab[onclick="switchTab('${tab}')"]`).classList.add('active');
  document.getElementById('tab-direct').style.display = tab === 'direct' ? 'block' : 'none';
  document.getElementById('tab-group').style.display = tab === 'group' ? 'block' : 'none';
}

async function createGroup() {
  const name = document.getElementById('group-name').value.trim();
  if (!name) return;
  const selected = [...document.querySelectorAll('#users-list-group .user-row.selected')];
  const memberIds = selected.map(el => parseInt(el.getAttribute('onclick').match(/\d+/)[0]));
  if (!memberIds.length) return;
  const data = await api('POST', '/chats/group', { name, member_ids: memberIds });
  if (data?.id) {
    closeModal('modal-new-chat');
    await loadChats();
    openChat(data.id);
  }
}

function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// Utils
function initials(name) {
  return (name || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
}
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
