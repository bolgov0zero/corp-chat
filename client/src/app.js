'use strict';

// ── STATE ──
const S = {
  server: '', token: null, user: null,
  chats: [], activeChatId: null,
  ws: null, wsRetry: 0,
  unread: {}, allUsers: [],
  settings: { theme: 'light', fontSize: 'medium' },
  ctx: { messageId: null, canEdit: false, isMine: false },
  editingMessageId: null,
  egChatId: null, egRemovedIds: new Set(), egAddIds: new Set(),
  presence: {}, // userId -> 'online'|'away'|'offline'
  reactions: {}, // messageId -> [{reaction, count}]
};

const SESSION_KEY = 'corp_chat_v2';

// ── UTILS ──
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function initials(n) { return (n||'?').split(' ').slice(0,2).map(w=>w[0]).join('').toUpperCase(); }
function fmtTime(ts) { return new Date(ts*1000).toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'}); }
function fmtDate(ts) {
  const d = new Date(ts*1000), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Сегодня';
  const y = new Date(now); y.setDate(y.getDate()-1);
  if (d.toDateString() === y.toDateString()) return 'Вчера';
  return d.toLocaleDateString('ru',{day:'numeric',month:'long'});
}
function avatarColor(id) { return ['av-blue','av-green','av-purple','av-orange'][id%4]; }

// ── API ──
async function api(method, path, body) {
  try {
    const res = await fetch(`http://${S.server}/api${path}`, {
      method,
      headers: { 'Content-Type':'application/json', ...(S.token?{Authorization:'Bearer '+S.token}:{}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { logout(); return null; }
    return res.json();
  } catch { return null; }
}

// ── SESSION ──
function saveSession() {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ server:S.server, token:S.token, user:S.user, settings:S.settings }));
}
function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}

// ── INIT ──
window.addEventListener('DOMContentLoaded', async () => {
  const session = loadSession();
  if (session?.token) {
    Object.assign(S, { server:session.server, token:session.token, user:session.user, settings:session.settings||S.settings });
    applySettings();
    enterApp();
  } else { applySettings(); }

  document.getElementById('l-password').addEventListener('keydown', e => e.key==='Enter' && doLogin());
  document.getElementById('l-server').addEventListener('keydown', e => e.key==='Enter' && document.getElementById('l-username').focus());
  document.getElementById('l-username').addEventListener('keydown', e => e.key==='Enter' && document.getElementById('l-password').focus());
  document.addEventListener('click', e => {
    hideCtxMenu();
    // Close emoji picker if click outside
    const picker = document.getElementById('emoji-picker');
    if (picker && !picker.contains(e.target) && !e.target.closest('.emoji-btn')) {
      picker.style.display = 'none';
    }
  });
  document.addEventListener('keydown', e => { if(e.key==='Escape'){ hideCtxMenu(); closeSettings(); }});
  window.electron?.onOpenChat(chatId => { const chat = S.chats.find(c=>c.id===chatId); if(chat) openChat(chatId); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      if (S.activeChatId && S.ws?.readyState===1) {
        S.ws.send(JSON.stringify({type:'read', chat_id: S.activeChatId}));
        S.unread[S.activeChatId] = 0;
        updateUnreadTotal();
      }
      if (S.ws?.readyState===1) S.ws.send(JSON.stringify({type:'set_status', status:'online'}));
    } else {
      if (S.ws?.readyState===1) S.ws.send(JSON.stringify({type:'set_status', status:'away'}));
    }
  });
});

// ── LOGIN ──
async function doLogin() {
  const server = document.getElementById('l-server').value.trim().replace(/^https?:\/\//,'');
  const username = document.getElementById('l-username').value.trim();
  const password = document.getElementById('l-password').value;
  const err = document.getElementById('l-err');
  const btn = document.getElementById('l-btn');
  if (!server||!username||!password) { err.textContent='Заполните все поля'; return; }
  btn.disabled=true; btn.textContent='Подключение...'; err.textContent='';
  try {
    const res = await fetch(`http://${server}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
    const data = await res.json();
    if (data.token) {
      Object.assign(S, { server, token:data.token, user:data.user });
      saveSession(); enterApp();
    } else { err.textContent = data.error||'Неверный логин или пароль'; }
  } catch { err.textContent='Не удалось подключиться к серверу'; }
  finally { btn.disabled=false; btn.textContent='Войти'; }
}

function logout() {
  closeSettings();
  if (S.ws) S.ws.close();
  Object.assign(S, { token:null, user:null, chats:[], activeChatId:null, ws:null, unread:{}, allUsers:[] });
  localStorage.removeItem(SESSION_KEY);
  document.getElementById('screen-main').classList.remove('active');
  document.getElementById('screen-login').classList.add('active');
}

// ── ENTER APP ──
function enterApp() {
  document.getElementById('screen-login').classList.remove('active');
  document.getElementById('screen-main').classList.add('active');
  updateMeAvatar();
  document.getElementById('me-name').textContent = S.user.display_name;
  loadChats();
  loadUsers();
  connectWS();
  loadPresence();
}

function updateMeAvatar() {
  const el = document.getElementById('me-av');
  const url = `http://${S.server}/api/users/${S.user.id}/avatar?t=${Date.now()}`;
  // Try loading avatar image
  const img = new Image();
  img.onload = () => {
    el.style.backgroundImage = `url('${url}')`;
    el.style.backgroundSize = 'cover';
    el.textContent = '';
  };
  img.onerror = () => {
    el.style.backgroundImage = '';
    el.textContent = initials(S.user.display_name);
  };
  img.src = url;
  el.className = `av av-sm ${avatarColor(S.user.id)}`;
}

// ── SETTINGS ──
function applySettings() {
  document.documentElement.classList.toggle('dark', S.settings.theme==='dark');
  document.documentElement.className = document.documentElement.className.replace(/font-\w+/,'');
  document.documentElement.classList.add('font-'+S.settings.fontSize);
  document.querySelectorAll('#theme-seg button').forEach(b => b.classList.toggle('active', b.textContent.trim()===(S.settings.theme==='light'?'Светлая':'Тёмная')));
  document.querySelectorAll('#font-seg button').forEach(b => b.classList.toggle('active', b.textContent.trim()===S.settings.fontSize[0].toUpperCase()));
}
function setTheme(t) { S.settings.theme=t; applySettings(); saveSession(); }
function setFontSize(f) { S.settings.fontSize=f; applySettings(); saveSession(); }
async function openSettings() {
  document.getElementById('drawer-settings').classList.add('open');
  document.getElementById('drawer-bg').classList.add('open');
  // Populate profile fields
  document.getElementById('profile-name-input').value = S.user.display_name;
  updateSettingsAvatar();
  if (window.electron?.getAutostart) {
    const row = document.getElementById('autostart-row');
    row.style.display = '';
    const enabled = await window.electron.getAutostart();
    document.getElementById('autostart-chk').checked = !!enabled;
  }
}
function closeSettings() { document.getElementById('drawer-settings').classList.remove('open'); document.getElementById('drawer-bg').classList.remove('open'); }
async function setAutostart(enabled) { await window.electron?.setAutostart(enabled); }

function updateSettingsAvatar() {
  const el = document.getElementById('settings-av');
  if (!el) return;
  const url = `http://${S.server}/api/users/${S.user.id}/avatar?t=${Date.now()}`;
  const img = new Image();
  img.onload = () => {
    el.style.backgroundImage = `url('${url}')`;
    el.style.backgroundSize = 'cover';
    el.textContent = '';
  };
  img.onerror = () => {
    el.style.backgroundImage = '';
    el.textContent = initials(S.user.display_name);
  };
  img.src = url;
}

async function saveProfile() {
  const name = document.getElementById('profile-name-input').value.trim();
  if (!name) return;
  const res = await api('PATCH', '/users/me', { display_name: name });
  if (res?.ok) {
    S.user.display_name = name;
    document.getElementById('me-name').textContent = name;
    saveSession();
    document.getElementById('profile-name-input').value = name;
  }
}

function triggerAvatarUpload() {
  document.getElementById('avatar-file-input').click();
}

async function onAvatarFileChange(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    const base64 = e.target.result.split(',')[1];
    const res = await api('POST', '/users/me/avatar', { data: base64 });
    if (res?.ok) {
      updateMeAvatar();
      updateSettingsAvatar();
    }
  };
  reader.readAsDataURL(file);
}

// ── CHAT LIST ──
async function loadChats() {
  const chats = await api('GET','/chats');
  if (!chats) return;
  S.chats = chats;
  renderChatList();
}

function chatName(chat) {
  if (chat.type==='group') return chat.name||'Группа';
  if (chat.type==='room') return chat.name||'Комната';
  const other = chat.members?.find(m=>m.id!==S.user.id);
  return other?.display_name||'Чат';
}

function chatAvatarClass(chat) {
  if (chat.type==='room') return 'av-orange';
  if (chat.type==='group') return 'av-green';
  return avatarColor(chat.id);
}

function chatIcon(chat) {
  if (chat.type==='room') return '🏠';
  return initials(chatName(chat));
}

function renderChatList() {
  const q = document.getElementById('search').value.toLowerCase();
  const list = document.getElementById('chats-list');
  // Rooms always on top, then sort by last message time
  const filtered = S.chats
    .filter(c=>chatName(c).toLowerCase().includes(q))
    .sort((a,b) => {
      if (a.type==='room' && b.type!=='room') return -1;
      if (a.type!=='room' && b.type==='room') return 1;
      const ta = a.last_message?.sent_at||0, tb = b.last_message?.sent_at||0;
      return tb-ta;
    });
  if (!filtered.length) { list.innerHTML='<div style="padding:20px;text-align:center;color:var(--sidebar-muted);font-size:13px">Нет чатов</div>'; return; }
  list.innerHTML = filtered.map(c => {
    const name = chatName(c);
    const u = S.unread[c.id]||0;
    const lm = c.last_message;
    let preview = lm ? (lm.deleted?'Сообщение удалено':lm.text) : 'Нет сообщений';
    if (preview.length>40) preview = preview.slice(0,40)+'…';
    const time = lm ? fmtTime(lm.sent_at) : '';
    const peerId = getPeerUserId(c);
    const dot = peerId ? presenceDot(peerId) : '';
    return `<div class="chat-item${c.id===S.activeChatId?' active':''}" onclick="openChat(${c.id})">
      <div class="av-wrap">
        <div class="av av-md ${chatAvatarClass(c)}">${chatIcon(c)}</div>
        ${dot}
      </div>
      <div class="info">
        <div class="ci-name">${esc(name)}</div>
        <div class="ci-preview">${esc(preview)}</div>
      </div>
      <div class="ci-right">
        <div class="ci-time">${time}</div>
        ${u>0?`<div class="unread-badge">${u}</div>`:''}
      </div>
    </div>`;
  }).join('');
}

function filterChats() { renderChatList(); }

// ── OPEN CHAT ──
async function openChat(chatId) {
  S.activeChatId = chatId;
  S.unread[chatId] = 0;
  updateUnreadTotal();
  renderChatList();
  const chat = S.chats.find(c=>c.id===chatId);
  const name = chatName(chat);
  const isGroup = chat.type==='group';
  const isRoom = chat.type==='room';
  const isCreator = chat.created_by === S.user.id;
  const memberCount = chat.members?.length||0;
  const peerId = getPeerUserId(chat);
  const peerDot = peerId ? presenceDot(peerId) : '';
  const sub = isRoom ? `🏠 Комната · ${memberCount} участников` : isGroup ? `${memberCount} участников` : 'Личный чат';
  const nameClickable = (isGroup || isRoom) ? `style="cursor:pointer" onclick="openGroupMembers(${chatId})"` : '';

  // Delete button: visible for direct chats and for group creator / admins
  const canDelete = chat.type === 'direct' || S.user.is_admin || isCreator;

  const main = document.getElementById('chat-main');
  main.innerHTML = `
    <div class="chat-header">
      <div class="av-wrap">
        <div class="av av-md ${chatAvatarClass(chat)}">${chatIcon(chat)}</div>
        ${peerDot}
      </div>
      <div class="chat-header-info" ${nameClickable}>
        <div class="ch-name">${esc(name)}</div>
        <div class="ch-sub">${sub}</div>
      </div>
      <div class="chat-header-actions">
        ${isGroup && isCreator ? `<button class="icon-btn light" title="Редактировать группу" onclick="openEditGroup(${chatId})">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>` : ''}
        ${isGroup?`<button class="icon-btn light" title="Выйти из группы" onclick="leaveGroup(${chatId})">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        </button>`:''}
        ${canDelete?`<button class="icon-btn light" title="Удалить чат" onclick="deleteChat(${chatId})">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
        </button>`:''}
      </div>
    </div>
    <div class="messages" id="messages"></div>
    <div class="chat-input-wrap" id="input-wrap">
      <div class="chat-input-area">
        <div id="edit-bar" style="display:none" class="input-edit-bar">
          <span>Редактирование</span>
          <button onclick="cancelEdit()" style="background:none;border:none;color:var(--primary);cursor:pointer;font-size:18px">✕</button>
        </div>
        <textarea id="msg-input" placeholder="Сообщение…" rows="1" onkeydown="handleKey(event)" oninput="autoResize(this)"></textarea>
      </div>
      <button class="icon-btn emoji-btn" title="Эмодзи" onclick="toggleEmojiPicker(event)">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
      </button>
      <button class="send-btn" onclick="sendOrEdit()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      </button>
    </div>`;

  if (S.ws && !document.hidden) S.ws.send(JSON.stringify({type:'read', chat_id: chatId}));
  const msgs = await api('GET', `/messages/chat/${chatId}`);
  if (msgs) renderMessages(msgs);
  document.getElementById('msg-input')?.focus();
}

// ── EMOJI PICKER ──
const EMOJIS = ['😀','😂','😍','😎','🤔','😭','😡','👍','👎','❤️','🔥','🎉','👏','🙏','💪','🤝','😊','🥳','😴','🤣','💯','✅','❌','🚀','⭐','💡','📌','🎯','💬','📷'];

function toggleEmojiPicker(e) {
  e.stopPropagation();
  let picker = document.getElementById('emoji-picker');
  if (!picker) {
    picker = document.createElement('div');
    picker.id = 'emoji-picker';
    picker.className = 'emoji-picker';
    picker.innerHTML = EMOJIS.map(em => `<button class="emoji-item" onclick="insertEmoji('${em}')">${em}</button>`).join('');
    document.body.appendChild(picker);
  }
  if (picker.style.display === 'grid') {
    picker.style.display = 'none';
    return;
  }
  const btn = e.currentTarget;
  const rect = btn.getBoundingClientRect();
  picker.style.display = 'grid';
  picker.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
  picker.style.right = (window.innerWidth - rect.right) + 'px';
}

function insertEmoji(em) {
  const input = document.getElementById('msg-input');
  if (!input) return;
  const start = input.selectionStart, end = input.selectionEnd;
  input.value = input.value.slice(0, start) + em + input.value.slice(end);
  input.selectionStart = input.selectionEnd = start + em.length;
  input.focus();
  autoResize(input);
  document.getElementById('emoji-picker').style.display = 'none';
}

// ── RENDER MESSAGES ──
function renderMessages(msgs) {
  const container = document.getElementById('messages');
  if (!container) return;
  const chat = S.chats.find(c=>c.id===S.activeChatId);
  const isGroup = chat?.type==='group';
  let html = '';
  let lastDate = '';
  msgs.forEach(m => {
    const dateStr = fmtDate(m.sent_at);
    if (dateStr!==lastDate) { html+=`<div class="date-divider"><span>${dateStr}</span></div>`; lastDate=dateStr; }
    html += renderMsg(m, isGroup);
  });
  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}

function renderReactions(msgId) {
  const counts = S.reactions[msgId] || [];
  if (!counts.length) return '';
  return `<div class="reactions">${counts.map(r =>
    `<button class="reaction-btn" onclick="sendReaction(${msgId},'${r.reaction}')">${r.reaction} <span>${r.count}</span></button>`
  ).join('')}</div>`;
}

function renderMsg(m, isGroup) {
  const mine = m.sender_id===S.user.id;
  const time = fmtTime(m.sent_at);
  const isDeleted = m.deleted;
  const bodyText = isDeleted ? 'Сообщение удалено' : esc(m.text) + (m.edited_at?` <span class="edited-tag">изм.</span>`:'');
  const statusIcon = mine && !isDeleted ? renderStatus(m.status) : '';
  const reactionsHtml = isDeleted ? '' : renderReactions(m.id);
  return `<div class="msg-group ${mine?'mine':'theirs'}" data-msg-id="${m.id}">
    ${isGroup&&!mine?`<div class="msg-sender">${esc(m.sender_name)}</div>`:''}
    <div class="msg-row">
      <div class="bubble${isDeleted?' deleted':''}" oncontextmenu="${!isDeleted?`showCtxMenu(event,${m.id},${m.sent_at},${mine})`:'event.preventDefault()'}">
        <div class="bubble-text">${bodyText}</div>
      </div>
    </div>
    ${reactionsHtml}
    <div class="msg-meta">
      <span class="msg-time">${time}</span>
      ${statusIcon}
    </div>
  </div>`;
}

function renderStatus(status) {
  if (!status) return '';
  const { delivered, read, total } = status;
  if (total===0) return '';
  let cls = 'status-sent', title='Отправлено';
  if (read>0) { cls='status-read'; title='Прочитано'; }
  else if (delivered>0) { cls='status-delivered'; title='Доставлено'; }
  const single = delivered===0;
  return `<span class="msg-status ${cls}" title="${title}">
    <svg viewBox="0 0 16 11" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      ${single
        ? '<polyline points="1,6 5,10 15,1"/>'
        : '<polyline points="1,6 5,10 15,1"/><polyline points="5,6 9,10 19,1" transform="translate(-4,0)"/>'}
    </svg>
  </span>`;
}

function appendMsg(m) {
  const container = document.getElementById('messages');
  if (!container) return;
  const chat = S.chats.find(c=>c.id===S.activeChatId);
  container.insertAdjacentHTML('beforeend', renderMsg(m, chat?.type==='group'));
  container.scrollTop = container.scrollHeight;
}

function updateMsgInDOM(m) {
  const el = document.querySelector(`[data-msg-id="${m.id}"]`);
  if (!el) return;
  const chat = S.chats.find(c=>c.id===S.activeChatId);
  el.outerHTML = renderMsg(m, chat?.type==='group');
}

// ── REACTIONS ──
function sendReaction(messageId, reaction) {
  if (S.ws?.readyState === 1) {
    S.ws.send(JSON.stringify({ type: 'react', message_id: messageId, reaction }));
  }
}

function ctxReact(reaction) {
  hideCtxMenu();
  sendReaction(S.ctx.messageId, reaction);
}

// ── SEND / EDIT ──
function handleKey(e) { if (e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendOrEdit(); } }
function autoResize(el) { el.style.height='auto'; el.style.height=Math.min(el.scrollHeight,120)+'px'; }

function sendOrEdit() {
  if (S.editingMessageId) { submitEdit(); return; }
  const input = document.getElementById('msg-input');
  const text = input?.value.trim();
  if (!text||!S.ws||S.ws.readyState!==1) return;
  S.ws.send(JSON.stringify({type:'message', chat_id:S.activeChatId, text}));
  input.value=''; input.style.height='auto';
}

function submitEdit() {
  const input = document.getElementById('msg-input');
  const text = input?.value.trim();
  if (!text) { cancelEdit(); return; }
  S.ws.send(JSON.stringify({type:'edit_message', message_id:S.editingMessageId, text}));
  cancelEdit();
}

function cancelEdit() {
  S.editingMessageId = null;
  const bar = document.getElementById('edit-bar');
  if (bar) bar.style.display='none';
  const input = document.getElementById('msg-input');
  if (input) { input.value=''; input.style.height='auto'; }
}

// ── CONTEXT MENU ──
function showCtxMenu(e, msgId, sentAt, isMine) {
  e.preventDefault(); e.stopPropagation();
  S.ctx.messageId = msgId;
  S.ctx.canEdit = isMine && (Date.now()/1000 - sentAt) < 120;
  S.ctx.isMine = isMine;
  const menu = document.getElementById('ctx-menu');
  document.getElementById('ctx-edit-btn').style.display = (isMine && S.ctx.canEdit) ? '' : 'none';
  document.getElementById('ctx-delete-btn').style.display = isMine ? '' : 'none';
  menu.style.left = Math.min(e.clientX, window.innerWidth-180)+'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight-140)+'px';
  menu.classList.add('open');
}
function hideCtxMenu() { document.getElementById('ctx-menu').classList.remove('open'); }

function ctxEdit() {
  hideCtxMenu();
  if (!S.ctx.canEdit) return;
  const el = document.querySelector(`[data-msg-id="${S.ctx.messageId}"] .bubble-text`);
  const text = el?.textContent?.replace(' изм.','').trim()||'';
  S.editingMessageId = S.ctx.messageId;
  const bar = document.getElementById('edit-bar');
  if (bar) bar.style.display='flex';
  const input = document.getElementById('msg-input');
  if (input) { input.value=text; input.focus(); autoResize(input); }
}

function ctxDelete() {
  hideCtxMenu();
  if (!S.ctx.messageId||!S.ws) return;
  S.ws.send(JSON.stringify({type:'delete_message', message_id:S.ctx.messageId}));
}

async function ctxInfo() {
  hideCtxMenu();
  const msgId = S.ctx.messageId;
  if (!msgId) return;
  const data = await api('GET', `/messages/${msgId}/info`);
  if (!data || data.error) return;

  function fmtDt(ts) {
    if (!ts) return '—';
    const d = new Date(ts * 1000);
    return d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'});
  }

  let body = `<div style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--border)">
    <div style="font-size:12px;color:var(--muted);margin-bottom:4px">Отправлено</div>
    <div style="font-size:14px">${fmtDt(data.sent_at)}</div>
  </div>`;

  if (data.chat_type === 'direct') {
    const s = data.statuses[0];
    body += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
      <div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:4px">Доставлено</div>
        <div style="font-size:14px">${fmtDt(s?.delivered_at)}</div>
      </div>
      <div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:4px">Прочитано</div>
        <div style="font-size:14px">${fmtDt(s?.read_at)}</div>
      </div>
    </div>`;
  } else {
    body += `<div style="font-size:12px;color:var(--muted);margin-bottom:10px">Прочитано участниками</div>`;
    if (!data.statuses.length) {
      body += `<div style="color:var(--muted);font-size:13px">Никто ещё не прочитал</div>`;
    } else {
      body += data.statuses.map(s => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border)">
          <div style="font-size:14px;font-weight:500">${esc(s.display_name)}</div>
          <div style="font-size:12px;color:var(--muted)">${s.read_at ? fmtDt(s.read_at) : '<span style="color:#94a3b8">не прочитано</span>'}</div>
        </div>`).join('');
    }
  }

  document.getElementById('msg-info-body').innerHTML = body;
  openModal('modal-msg-info');
}

// ── DELETE CHAT / LEAVE GROUP ──
async function deleteChat(chatId) {
  if (!confirm('Удалить чат?')) return;
  await api('DELETE', `/chats/${chatId}`);
  // The WS chat_deleted event will handle the cleanup, but also handle locally if no WS
  removeChatLocally(chatId);
}

function removeChatLocally(chatId) {
  S.chats = S.chats.filter(c=>c.id!==chatId);
  if (S.activeChatId === chatId) {
    S.activeChatId = null;
    document.getElementById('chat-main').innerHTML = `<div class="empty-state"><div class="empty-icon">💬</div><div class="empty-title">Corp Chat</div><div class="empty-sub">Выберите чат или создайте новый</div></div>`;
  }
  renderChatList();
}

function openGroupMembers(chatId) {
  const chat = S.chats.find(c=>c.id===chatId);
  if (!chat) return;
  document.getElementById('gm-title').textContent = chatName(chat);
  document.getElementById('gm-list').innerHTML = (chat.members||[]).map(m => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid var(--border)">
      <div class="av av-sm ${avatarColor(m.id)}">${initials(m.display_name)}</div>
      <div>
        <div style="font-size:14px;font-weight:500">${esc(m.display_name)}</div>
        <div style="font-size:12px;color:var(--muted)">@${esc(m.username)}</div>
      </div>
      ${chat.created_by===m.id?'<span style="margin-left:auto;font-size:11px;color:var(--muted);background:var(--bg);padding:2px 8px;border-radius:10px">создатель</span>':''}
    </div>`).join('') || '<div style="color:var(--muted);text-align:center;padding:20px">Нет участников</div>';
  openModal('modal-group-members');
}

async function leaveGroup(chatId) {
  if (!confirm('Выйти из группы?')) return;
  await api('POST', `/chats/${chatId}/leave`);
  S.activeChatId = null;
  document.getElementById('chat-main').innerHTML = `<div class="empty-state"><div class="empty-icon">💬</div><div class="empty-title">Corp Chat</div><div class="empty-sub">Выберите чат или создайте новый</div></div>`;
  loadChats();
}

// ── WEBSOCKET ──
function connectWS() {
  const ws = new WebSocket(`ws://${S.server}/ws?token=${S.token}`);
  S.ws = ws;

  ws.onmessage = e => {
    let data; try { data=JSON.parse(e.data); } catch { return; }

    if (data.type==='message') {
      const { message } = data;
      const chatId = message.chat_id;
      const chat = S.chats.find(c=>c.id===chatId);
      if (chat) chat.last_message = message;
      if (S.activeChatId===chatId && !document.hidden) {
        appendMsg(message);
        if (S.ws?.readyState===1) S.ws.send(JSON.stringify({type:'read', chat_id:chatId}));
        if (S.ws?.readyState===1) S.ws.send(JSON.stringify({type:'delivered', message_id:message.id}));
      } else {
        S.unread[chatId] = (S.unread[chatId]||0)+1;
        if (message.sender_id!==S.user.id) {
          const chat2 = S.chats.find(c=>c.id===chatId);
          const title = chatName(chat2) || 'Corp Chat';
          const body = `${message.sender_name}: ${message.text}`;
          window.electron?.notify(title, body, chatId);
        }
        if (S.ws?.readyState===1) S.ws.send(JSON.stringify({type:'delivered', message_id:message.id}));
      }
      updateUnreadTotal();
      renderChatList();
      if (!chat) loadChats();
    }

    if (data.type==='message_edited') {
      const m = data.message;
      const chat = S.chats.find(c=>c.id===m.chat_id);
      if (chat?.last_message?.id===m.id) chat.last_message = m;
      if (S.activeChatId===m.chat_id) updateMsgInDOM(m);
      renderChatList();
    }

    if (data.type==='message_deleted') {
      const { message_id, chat_id } = data;
      const chat = S.chats.find(c=>c.id===chat_id);
      if (chat?.last_message?.id===message_id) chat.last_message = {...chat.last_message, deleted:1, text:''};
      if (S.activeChatId===chat_id) {
        const el = document.querySelector(`[data-msg-id="${message_id}"]`);
        if (el) { const b=el.querySelector('.bubble'); if(b){b.classList.add('deleted');b.querySelector('.bubble-text').innerHTML='Сообщение удалено';} }
      }
      renderChatList();
    }

    if (data.type==='reload_chats') {
      loadChats();
    }

    // Fix 1: handle chat_deleted WS event
    if (data.type==='chat_deleted') {
      removeChatLocally(data.chat_id);
    }

    if (data.type==='reaction_update') {
      const { message_id, counts } = data;
      S.reactions[message_id] = counts;
      // Update reactions in DOM if message is visible
      if (S.activeChatId) {
        const msgEl = document.querySelector(`[data-msg-id="${message_id}"]`);
        if (msgEl) {
          const existing = msgEl.querySelector('.reactions');
          const reactionsHtml = renderReactions(message_id);
          if (existing) {
            existing.outerHTML = reactionsHtml || '';
          } else if (reactionsHtml) {
            const meta = msgEl.querySelector('.msg-meta');
            if (meta) meta.insertAdjacentHTML('beforebegin', reactionsHtml);
          }
        }
      }
    }

    if (data.type==='presence') {
      S.presence[data.user_id] = data.status;
      renderChatList();
      if (S.activeChatId) {
        const chat = S.chats.find(c=>c.id===S.activeChatId);
        if (chat && getPeerUserId(chat) === data.user_id) {
          const dotEl = document.querySelector('.chat-header .presence-dot');
          if (dotEl) {
            const color = data.status==='online'?'#22c55e':data.status==='away'?'#eab308':'#ef4444';
            dotEl.style.background = color;
            dotEl.title = data.status;
          }
        }
      }
    }

    if (data.type==='status_update') {
      const m = data.message;
      if (S.activeChatId===m.chat_id && m.sender_id===S.user.id) {
        const el = document.querySelector(`[data-msg-id="${m.id}"] .msg-status`);
        if (el) el.outerHTML = renderStatus(m.status);
      }
    }
  };

  ws.onclose = () => {
    S.wsRetry++;
    const delay = Math.min(1000*S.wsRetry, 10000);
    if (S.token) setTimeout(connectWS, delay);
  };
  ws.onopen = () => {
    S.wsRetry = 0;
    ws.send(JSON.stringify({ type: 'set_status', status: document.hidden ? 'away' : 'online' }));
  };
  ws.onerror = () => ws.close();
}

function updateUnreadTotal() {
  const total = Object.values(S.unread).reduce((a,b)=>a+b,0);
  window.electron?.setUnread(total);
}

// ── USERS ──
async function loadUsers() {
  const users = await api('GET','/users');
  if (users) S.allUsers = users;
}

// ── PRESENCE ──
async function loadPresence() {
  const data = await api('GET', '/users/presence');
  if (data) { S.presence = data; renderChatList(); }
}

function presenceDot(userId) {
  const s = S.presence[userId] || 'offline';
  const color = s === 'online' ? '#22c55e' : s === 'away' ? '#eab308' : '#ef4444';
  return `<span class="presence-dot" style="background:${color}" title="${s}"></span>`;
}

function getPeerUserId(chat) {
  if (chat.type !== 'direct') return null;
  return chat.members?.find(m => m.id !== S.user.id)?.id || null;
}

// ── NEW CHAT MODAL ──
function openNewChat() {
  renderModalUsers('users-list-direct', false);
  renderModalUsers('users-list-group', true);
  document.getElementById('group-name').value='';
  document.querySelectorAll('#users-list-group .user-row').forEach(el=>el.classList.remove('selected'));
  openModal('modal-new-chat');
}

function renderModalUsers(containerId, multi, filter='') {
  const container = document.getElementById(containerId);
  if (!container) return;
  const list = S.allUsers.filter(u=>!filter||u.display_name.toLowerCase().includes(filter)||u.username.toLowerCase().includes(filter));
  container.innerHTML = list.map(u=>`
    <div class="user-row" data-uid="${u.id}" onclick="${multi?`toggleModalUser(this,${u.id})`:`startDirect(${u.id})`}">
      <div class="av av-sm ${avatarColor(u.id)}">${initials(u.display_name)}</div>
      <div><div class="uname">${esc(u.display_name)}</div><div class="ulogin">@${esc(u.username)}</div></div>
    </div>`).join('') || '<div style="padding:12px;color:var(--muted);font-size:13px">Нет пользователей</div>';
}

function filterModalUsers(q, containerId) {
  const multi = containerId==='users-list-group';
  renderModalUsers(containerId, multi, q.toLowerCase());
}

function toggleModalUser(el, id) {
  el.classList.toggle('selected');
}

async function startDirect(userId) {
  closeModal('modal-new-chat');
  const data = await api('POST','/chats/direct',{user_id:userId});
  if (data?.id) { await loadChats(); openChat(data.id); }
}

async function createGroup() {
  const name = document.getElementById('group-name').value.trim();
  if (!name) { document.getElementById('group-name').focus(); return; }
  const selected = [...document.querySelectorAll('#users-list-group .user-row.selected')].map(el=>parseInt(el.dataset.uid));
  const data = await api('POST','/chats/group',{name, member_ids:selected});
  if (data?.id) { closeModal('modal-new-chat'); await loadChats(); openChat(data.id); }
}

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.querySelector(`.tab[onclick="switchTab('${tab}')"]`).classList.add('active');
  document.getElementById('tab-direct').style.display = tab==='direct'?'':'none';
  document.getElementById('tab-group').style.display = tab==='group'?'':'none';
}

// ── EDIT GROUP MODAL ──
async function openEditGroup(chatId) {
  S.egChatId = chatId;
  S.egRemovedIds = new Set();
  S.egAddIds = new Set();
  const chat = S.chats.find(c=>c.id===chatId);
  document.getElementById('eg-name').value = chat.name||'';
  renderEgMembers(chat.members||[]);
  renderEgAdd(chat.members||[]);
  openModal('modal-edit-group');
}

function renderEgMembers(members) {
  const container = document.getElementById('eg-members');
  container.innerHTML = members.filter(m=>m.id!==S.user.id&&!S.egRemovedIds.has(m.id)).map(m=>`
    <div class="member-remove-row" id="egm-${m.id}">
      <div class="av av-sm ${avatarColor(m.id)}">${initials(m.display_name)}</div>
      <div class="info"><div class="rname">${esc(m.display_name)}</div><div class="rlogin">@${esc(m.username)}</div></div>
      <button class="rm-btn" onclick="egRemoveMember(${m.id})">✕</button>
    </div>`).join('') || '<div style="font-size:13px;color:var(--muted)">Только вы</div>';
}

function renderEgAdd(existingMembers) {
  const existingIds = new Set(existingMembers.map(m=>m.id));
  const container = document.getElementById('eg-add');
  const available = S.allUsers.filter(u=>!existingIds.has(u.id)||S.egRemovedIds.has(u.id));
  container.innerHTML = available.map(u=>`
    <div class="user-row${S.egAddIds.has(u.id)?' selected':''}" data-uid="${u.id}" onclick="egToggleAdd(this,${u.id})">
      <div class="av av-sm ${avatarColor(u.id)}">${initials(u.display_name)}</div>
      <div><div class="uname">${esc(u.display_name)}</div><div class="ulogin">@${esc(u.username)}</div></div>
    </div>`).join('') || '<div style="font-size:13px;color:var(--muted)">Нет доступных</div>';
}

function egRemoveMember(id) {
  S.egRemovedIds.add(id);
  document.getElementById(`egm-${id}`)?.remove();
}

function egToggleAdd(el, id) {
  el.classList.toggle('selected');
  S.egAddIds.has(id) ? S.egAddIds.delete(id) : S.egAddIds.add(id);
}

async function saveGroupEdit() {
  const name = document.getElementById('eg-name').value.trim();
  const chatId = S.egChatId;
  await Promise.all([
    name && api('PATCH',`/chats/${chatId}`,{name}),
    ...[...S.egRemovedIds].map(uid=>api('DELETE',`/chats/${chatId}/members/${uid}`)),
    ...[...S.egAddIds].map(uid=>api('POST',`/chats/${chatId}/members`,{user_id:uid})),
  ]);
  closeModal('modal-edit-group');
  await loadChats();
  if (S.activeChatId===chatId) openChat(chatId);
}

// ── MODAL HELPERS ──
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
