'use strict';

// ── STATE ──
const S = {
  server: '', token: null, user: null,
  chats: [], activeChatId: null,
  ws: null, wsRetry: 0,
  unread: {}, allUsers: [], drafts: (()=>{ try { return JSON.parse(localStorage.getItem('chat_drafts'))||{}; } catch { return {}; } })(),
  settings: { theme: 'dark', fontSize: 'medium', chatView: 'irc' },
  ctx: { messageId: null, canEdit: false, isMine: false, replyText: '', replySenderName: '' },
  editingMessageId: null,
  replyTo: null, // { id, text, senderName }
  egChatId: null, egRemovedIds: new Set(), egAddIds: new Set(),
  newGroupAvatarBase64: null,
  presence: {},
  lastSeen: {}, // userId -> unix ts последнего онлайна // userId -> 'online'|'away'|'offline'
  reactions: {}, // messageId -> [{reaction, count}]
  chatHasMore: false,   // есть ли ещё сообщения выше
  chatOldestId: null,   // id самого старого загруженного сообщения
  chatHasMoreAfter: false, // есть ли сообщения ниже (после перехода вглубь истории)
  chatNewestId: null,      // id самого нового загруженного сообщения
  searchResults: null,     // результаты поиска по сообщениям
};

const SESSION_KEY = 'electron_v2';

// ── ACTIVITY (видит ли пользователь чат) ──
// Окно может быть видимым, но не в фокусе (за другим окном) — тогда сообщения
// не должны помечаться прочитанными, а статус должен быть «отошёл».
let _winFocused = true;
function isViewing() { return !document.hidden && _winFocused; }

// Единая реакция на смену видимости/фокуса: прочтение активного чата + статус.
function refreshActivity() {
  const viewing = isViewing();
  if (viewing && S.activeChatId && S.ws?.readyState===1) {
    S.ws.send(JSON.stringify({type:'read', chat_id: S.activeChatId}));
    S.unread[S.activeChatId] = 0;
    updateUnreadTotal();
  }
  if (S.ws?.readyState===1) S.ws.send(JSON.stringify({type:'set_status', status: viewing ? 'online' : 'away'}));
  updateSidebarStatus(viewing ? 'online' : 'away');
}

// ── PAGINATION ──
let _loadingMore = false; // флаг чтобы не делать двойной запрос

// ── AVATAR CACHE ──
const _avatarCache = new Map(); // url -> true (loaded) | false (error)

let _fetchController = new AbortController();

// ── UTILS ──
function saveDrafts() { try { localStorage.setItem('chat_drafts', JSON.stringify(S.drafts)); } catch {} }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function linkifyText(text) {
  const urlRe = /(https?:\/\/[^\s]+)/g;
  return text.split(urlRe).map((part, i) => {
    if (i % 2 !== 1) return esc(part);
    return `<a class="msg-link" href="#" onclick="openExternalLink(event,this)" data-url="${esc(part)}">${esc(part)}</a>`;
  }).join('');
}

function openExternalLink(e, el) {
  e.preventDefault();
  document.getElementById('modal-link').dataset.url = el.dataset.url;
  document.getElementById('link-modal-url').textContent = el.dataset.url;
  openModal('modal-link');
}

function confirmLink() {
  const url = document.getElementById('modal-link').dataset.url;
  closeModal('modal-link');
  window.open(url, '_blank', 'noopener,noreferrer');
}
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
function formatEditLimit(sec) {
  if (sec < 60) return `${sec} сек`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} мин`;
  return `${Math.round(min / 60)} ч`;
}

// ── PROTOCOL ──
// Если в адресе есть порт — прямое подключение (http/ws), иначе через прокси (https/wss)
function httpProto() { return /:\d+$/.test(S.server) ? 'http' : 'https'; }
function wsProto()   { return /:\d+$/.test(S.server) ? 'ws'   : 'wss';   }

// ── API ──
async function api(method, path, body) {
  try {
    const res = await fetch(`${httpProto()}://${S.server}/api${path}`, {
      method,
      headers: { 'Content-Type':'application/json', ...(S.token?{Authorization:'Bearer '+S.token}:{}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: _fetchController.signal,
    });
    if (res.status === 401) { logout(); return null; }
    return res.json();
  } catch(e) {
    if (e?.name === 'AbortError') return null;
    return null;
  }
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
  // Версия — всегда, независимо от сессии
  if (window.electron?.getVersion) {
    window.electron.getVersion().then(v => {
      if (!v) return;
      const lv = document.getElementById('login-version');
      if (lv) lv.textContent = `v${v}`;
      const av = document.getElementById('app-version');
      if (av) av.textContent = `v${v}`;
    });
  }

  const session = loadSession();
  if (session?.token) {
    Object.assign(S, { server:session.server, token:session.token, user:session.user, settings:session.settings||S.settings });
    applySettings();
    enterApp();
  } else {
    applySettings();
    const lastServer = localStorage.getItem('lastServer');
    if (lastServer) document.getElementById('l-server').value = lastServer;
  }

  // Show HA button on Windows only
  if (window.electron) {
    const platform = await window.electron.getPlatform();
    if (platform === 'win32') {
      const btn = document.getElementById('ha-toggle-btn');
      if (btn) {
        btn.style.display = 'flex';
        const cfg = await window.electron.getHAConfig();
        if (cfg?.drive) {
          btn.classList.add('ha-active');
          document.getElementById('ha-toggle-label').textContent = `Высокая доступность: ${cfg.drive}:\\`;
        }
      }
    }
  }

  document.getElementById('l-password').addEventListener('keydown', e => e.key==='Enter' && doLogin());
  document.getElementById('l-server').addEventListener('keydown', e => e.key==='Enter' && document.getElementById('l-username').focus());
  document.getElementById('l-username').addEventListener('keydown', e => e.key==='Enter' && document.getElementById('l-password').focus());
  document.addEventListener('click', e => {
    hideCtxMenu();
    document.getElementById('ctx-chat-menu').style.display = 'none';
    // Close emoji picker if click outside
    const picker = document.getElementById('emoji-picker');
    if (picker && !picker.contains(e.target) && !e.target.closest('.emoji-btn')) {
      picker.style.display = 'none';
    }
  });
  document.addEventListener('keydown', e => { if(e.key==='Escape'){ hideCtxMenu(); closeSettings(); }});
  window.electron?.onOpenChat(chatId => { const chat = S.chats.find(c=>c.id===chatId); if(chat) openChat(chatId); });
  document.addEventListener('visibilitychange', refreshActivity);
  // Реальный фокус окна из main-процесса — авторитетный признак «пользователь смотрит».
  window.electron?.onWindowFocus?.(focused => { _winFocused = focused; refreshActivity(); });

  // ── Drag-and-drop изображений в окно чата ──
  document.addEventListener('dragover', e => {
    if (!S.activeChatId) return;
    e.preventDefault();
    document.getElementById('drag-overlay')?.classList.add('visible');
  });
  document.addEventListener('dragleave', e => {
    if (e.relatedTarget && document.body.contains(e.relatedTarget)) return;
    document.getElementById('drag-overlay')?.classList.remove('visible');
  });
  document.addEventListener('drop', async e => {
    e.preventDefault();
    document.getElementById('drag-overlay')?.classList.remove('visible');
    if (!S.activeChatId) return;
    const file = Array.from(e.dataTransfer.files).find(f => f.type.startsWith('image/'));
    if (file) await uploadImageFile(file);
  });

  // ── Вставка изображения из буфера обмена ──
  document.addEventListener('paste', async e => {
    if (!S.activeChatId) return;
    const file = Array.from(e.clipboardData.items)
      .find(i => i.type.startsWith('image/'))?.getAsFile();
    if (file) { e.preventDefault(); await uploadImageFile(file); }
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
    const proto = /:\d+$/.test(server) ? 'http' : 'https';
    const res = await fetch(`${proto}://${server}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
    const data = await res.json();
    if (data.token) {
      Object.assign(S, { server, token:data.token, user:data.user });
      saveSession(); enterApp();
    } else { err.textContent = data.error||'Неверный логин или пароль'; }
  } catch { err.textContent='Не удалось подключиться к серверу'; }
  finally { btn.disabled=false; btn.textContent='Войти'; }
}

function logout() {
  _fetchController.abort();
  _fetchController = new AbortController();
  closeSettings();
  if (S.ws) S.ws.close();
  if (S.server) {
    localStorage.setItem('lastServer', S.server);
    const serverInput = document.getElementById('l-server');
    if (serverInput) serverInput.value = S.server;
  }
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
  const url = `${httpProto()}://${S.server}/api/users/${S.user.id}/avatar?t=${Date.now()}`;
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

function updateSidebarStatus(status) {
  const dot = document.getElementById('me-status-dot');
  const txt = document.getElementById('me-status-text');
  if (!dot || !txt) return;
  const map = { online: { color: '#22c55e', label: 'онлайн' }, away: { color: '#eab308', label: 'отошёл' }, offline: { color: '#ef4444', label: 'не в сети' } };
  const s = map[status] || map.online;
  dot.style.background = s.color;
  txt.textContent = s.label;
}

// ── SETTINGS ──
function applySettings() {
  const isDark = S.settings.theme === 'dark';
  document.documentElement.classList.toggle('dark', isDark);
  document.documentElement.className = document.documentElement.className.replace(/font-\w+/,'');
  document.documentElement.classList.add('font-'+S.settings.fontSize);
  document.querySelectorAll('#theme-seg button').forEach(b => b.classList.toggle('active', b.textContent.trim()===(S.settings.theme==='light'?'Светлая':'Тёмная')));
  document.querySelectorAll('#font-seg button').forEach(b => b.classList.toggle('active', b.textContent.trim()===S.settings.fontSize[0].toUpperCase()));
  // Sidebar theme toggle icon
  const sunIcon = document.getElementById('theme-icon-sun');
  const moonIcon = document.getElementById('theme-icon-moon');
  if (sunIcon) sunIcon.style.display = isDark ? '' : 'none';
  if (moonIcon) moonIcon.style.display = isDark ? 'none' : '';
}
function setTheme(t) { S.settings.theme=t; applySettings(); saveSession(); }
function toggleTheme() { setTheme(S.settings.theme === 'dark' ? 'light' : 'dark'); }
function setFontSize(f) { S.settings.fontSize=f; applySettings(); saveSession(); }
async function openSettings() {
  document.getElementById('modal-settings').classList.add('open');
  const dn = document.getElementById('settings-display-name');
  if (dn) { dn.value = S.user.display_name; dn.readOnly = true; dn.classList.remove('editing'); }
  const un = document.getElementById('settings-username');
  if (un) un.textContent = '@' + S.user.username;
  const btn = document.getElementById('settings-edit-btn');
  if (btn) btn.textContent = 'Изменить';
  updateSettingsAvatar();
  if (window.electron?.getAutostart) {
    const row = document.getElementById('autostart-row');
    if (row) row.style.display = '';
    const enabled = await window.electron.getAutostart();
    const chk = document.getElementById('autostart-chk');
    if (chk) chk.checked = !!enabled;
  }
  const soundChk = document.getElementById('sound-chk');
  if (soundChk) soundChk.checked = S.settings.soundEnabled !== false;
  applySettings();
}
function closeSettings() { closeModal('modal-settings'); }
function openNameEdit() {
  const input = document.getElementById('settings-display-name');
  const btn = document.getElementById('settings-edit-btn');
  if (!input) return;
  if (input.readOnly) {
    input.readOnly = false;
    input.classList.add('editing');
    input.focus();
    input.select();
    if (btn) btn.textContent = 'Сохранить';
  } else {
    saveDisplayName();
  }
}
async function saveDisplayName() {
  const input = document.getElementById('settings-display-name');
  const btn = document.getElementById('settings-edit-btn');
  const name = input?.value?.trim();
  if (name) {
    const res = await api('PATCH', '/users/me', { display_name: name });
    if (res?.ok) {
      S.user.display_name = name;
      document.getElementById('me-name').textContent = name;
      saveSession();
    }
  }
  if (input) { input.readOnly = true; input.classList.remove('editing'); }
  if (btn) btn.textContent = 'Изменить';
}
async function setAutostart(enabled) { await window.electron?.setAutostart(enabled); }

function updateSettingsAvatar() {
  const el = document.getElementById('settings-av');
  if (!el) return;
  el.className = `av av-lg ${avatarColor(S.user.id)}`;
  const url = `${httpProto()}://${S.server}/api/users/${S.user.id}/avatar?t=${Date.now()}`;
  const img = new Image();
  img.onload = () => {
    el.style.backgroundImage = `url('${url}')`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
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
    const dn = document.getElementById('settings-display-name');
    if (dn) dn.textContent = name;
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

// ── NOTIFICATION SOUND ──
let _audioCtx = null;
function playNotificationSound() {
  if (S.settings.soundEnabled === false) return;
  try {
    if (!_audioCtx || _audioCtx.state === 'closed') {
      _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    const osc = _audioCtx.createOscillator();
    const gain = _audioCtx.createGain();
    osc.connect(gain);
    gain.connect(_audioCtx.destination);
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.25, _audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, _audioCtx.currentTime + 0.3);
    osc.start(_audioCtx.currentTime);
    osc.stop(_audioCtx.currentTime + 0.3);
  } catch(e) {}
}

// ── CHAT LIST ──
async function loadChats() {
  const chats = await api('GET','/chats');
  if (!chats) return;
  S.chats = chats;
  // Сервер — источник истины по непрочитанным (синхронизация между устройствами).
  // Активный чат считаем прочитанным сразу.
  chats.forEach(c => { S.unread[c.id] = (c.id === S.activeChatId) ? 0 : (c.unread || 0); });
  updateUnreadTotal();
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
  return avatarColor(getPeerUserId(chat) || chat.id);
}

function chatIcon(chat) {
  if (chat.type==='room') return '🏠';
  return initials(chatName(chat));
}

// Try loading real photo into an .av element; fall back to initials if 404
function tryLoadAvatar(el, url, fallbackText) {
  const cached = _avatarCache.get(url);
  if (cached === true) {
    el.style.backgroundImage = `url('${url}')`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
    el.textContent = '';
    return;
  }
  if (cached === false) {
    el.style.backgroundImage = '';
    el.textContent = fallbackText;
    return;
  }
  const img = new Image();
  img.onload = () => {
    _avatarCache.set(url, true);
    el.style.backgroundImage = `url('${url}')`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
    el.textContent = '';
  };
  img.onerror = () => {
    _avatarCache.set(url, false);
    el.style.backgroundImage = '';
    el.textContent = fallbackText;
  };
  img.src = url;
}

// After rendering chat list / chat header — load real avatars where available
function applyAvatars() {
  // Chat list items: data-chat-id attribute
  document.querySelectorAll('[data-av-chat]').forEach(el => {
    const chatId = parseInt(el.dataset.avChat);
    const chat = S.chats.find(c => c.id === chatId);
    if (!chat) return;
    if (chat.type === 'direct') {
      const peerId = getPeerUserId(chat);
      if (!peerId) return;
      const url = `${httpProto()}://${S.server}/api/users/${peerId}/avatar?t=${S.avatarTs||0}`;
      tryLoadAvatar(el, url, initials(chatName(chat)));
    } else {
      const url = `${httpProto()}://${S.server}/api/chats/${chatId}/avatar?t=${S.avatarTs||0}`;
      tryLoadAvatar(el, url, chatIcon(chat));
    }
  });
  // User avatars in modals / member lists
  document.querySelectorAll('[data-av-user]').forEach(el => {
    const uid = parseInt(el.dataset.avUser);
    const user = S.allUsers.find(u => u.id === uid) || (uid === S.user.id ? S.user : null);
    if (!user) return;
    const url = `${httpProto()}://${S.server}/api/users/${uid}/avatar?t=${S.avatarTs||0}`;
    tryLoadAvatar(el, url, initials(user.display_name));
  });
}

function renderChatList() {
  const q = document.getElementById('search').value.toLowerCase();
  const list = document.getElementById('chats-list');
  const filtered = S.chats
    .filter(c=>chatName(c).toLowerCase().includes(q))
    .sort((a,b) => {
      if (a.type==='room' && b.type!=='room') return -1;
      if (a.type!=='room' && b.type==='room') return 1;
      const ta = a.last_message?.sent_at||0, tb = b.last_message?.sent_at||0;
      return tb-ta;
    });
  const pinned = filtered.filter(c => c.pinned || c.type === 'room');
  const rest = filtered.filter(c => !c.pinned && c.type !== 'room');

  let html = '';
  if (!filtered.length) {
    html += '<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px">Нет чатов</div>';
  } else {
    if (pinned.length) {
      html += `<div class="chat-list-section-label">Закреплённые</div>`;
      html += pinned.map(c => renderChatRow(c)).join('');
    }
    html += `<div class="chat-list-section-label" style="${pinned.length?'padding-top:12px':''}">Все чаты</div>`;
    html += rest.map(c => renderChatRow(c)).join('');
  }
  if (S.searchResults) {
    html += `<div class="chat-list-section-label" style="padding-top:12px">Сообщения</div>`;
    html += S.searchResults.length
      ? S.searchResults.map(r => renderSearchRow(r)).join('')
      : '<div style="padding:12px 20px;color:var(--muted);font-size:13px">Ничего не найдено</div>';
  }
  list.innerHTML = html;
  applyAvatars();
}

function renderChatRow(c) {
  const name = chatName(c);
  const u = S.unread[c.id]||0;
  const lm = c.last_message;
  let preview = lm ? (lm.deleted ? 'Сообщение удалено' : (lm.text || (lm.attachment ? '🖼 Изображение' : ''))) : 'Нет сообщений';
  if (preview.length>40) preview = preview.slice(0,40)+'…';
  // Черновик приоритетнее последнего сообщения (как в Telegram)
  const draft = (c.id !== S.activeChatId) ? S.drafts[c.id] : null;
  const previewHtml = draft
    ? `<span style="color:var(--danger)">Черновик:</span> ${esc(draft.slice(0,34))}`
    : esc(preview);
  const time = lm ? fmtTime(lm.sent_at) : '';
  const peerId = getPeerUserId(c);
  const dot = peerId ? presenceDot(peerId) : '';
  const pinIcon = c.pinned ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--muted);opacity:.7"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>` : '';
  return `<div class="chat-item${c.id===S.activeChatId?' active':''}" data-chat-id="${c.id}" onclick="openChat(${c.id})" oncontextmenu="showChatCtx(event,${c.id})">
    <div class="av-wrap">
      <div class="av av-md ${chatAvatarClass(c)}${c.type==='direct'?' av-round':''}" data-av-chat="${c.id}">${chatIcon(c)}</div>
      ${dot}
    </div>
    <div class="info">
      <div class="ci-name" style="display:flex;align-items:center;gap:5px">
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</span>
        ${pinIcon}
        <span class="ci-time">${time}</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin-top:2px">
        <span class="ci-preview ci-last" style="flex:1">${previewHtml}</span>
        ${u>0?`<div class="unread-badge">${u}</div>`:''}
      </div>
    </div>
  </div>`;
}

let _searchTimer = null;
function filterChats() {
  renderChatList();
  const q = document.getElementById('search').value.trim();
  clearTimeout(_searchTimer);
  if (q.length < 2) {
    if (S.searchResults) { S.searchResults = null; renderChatList(); }
    return;
  }
  _searchTimer = setTimeout(async () => {
    const data = await api('GET', `/messages/search?q=${encodeURIComponent(q)}`);
    if (document.getElementById('search')?.value.trim() !== q) return; // запрос устарел
    S.searchResults = data?.results || [];
    renderChatList();
  }, 300);
}

function renderSearchRow(r) {
  const chat = S.chats.find(c => c.id === r.chat_id);
  const title = chat ? chatName(chat) : (r.sender_name || '');
  const snip = esc(r.snippet || '').replaceAll('\u0001', '<b>').replaceAll('\u0002', '</b>');
  return `<div class="chat-item" onclick="openSearchResult(${r.chat_id},${r.id})">
    <div class="av av-md ${avatarColor(r.sender_id || 0)} av-round">${initials(r.sender_name || '?')}</div>
    <div class="info">
      <div class="ci-name" style="display:flex;align-items:center;gap:5px">
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(title)}</span>
        <span class="ci-time">${fmtTime(r.sent_at)}</span>
      </div>
      <div class="ci-preview" style="margin-top:2px">${esc(r.sender_name || '')}: ${snip}</div>
    </div>
  </div>`;
}

function openSearchResult(chatId, msgId) {
  const input = document.getElementById('search');
  if (input) input.value = '';
  S.searchResults = null;
  renderChatList();
  openChat(chatId, msgId);
}

// ── OPEN CHAT ──
async function openChat(chatId, aroundId = null) {
  S.activeChatId = chatId;
  S.chatHasMore = false;
  S.chatOldestId = null;
  S.chatHasMoreAfter = false;
  S.chatNewestId = null;
  _loadingMore = false;
  const _unreadAtOpen = S.unread[chatId] || 0;
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
  const sub = isRoom ? `🏠 Комната · ${memberCount} участников` : isGroup ? `${memberCount} участников` : (peerId ? peerStatusText(peerId) : 'Личный чат');
  const nameClickable = (isGroup || isRoom) ? `style="cursor:pointer" onclick="openGroupMembers(${chatId})"` : '';

  // Delete button: visible for direct chats and for group creator / admins
  const canDelete = chat.type === 'direct' || S.user.is_admin || isCreator;

  const main = document.getElementById('chat-main');
  main.innerHTML = `
    <div class="chat-header">
      <div class="av-wrap">
        <div class="av av-md ${chatAvatarClass(chat)}${chat.type==='direct'?' av-round':''}" data-av-chat="${chat.id}">${chatIcon(chat)}</div>
        ${peerDot}
      </div>
      <div class="chat-header-info" ${nameClickable}>
        <div class="ch-name">${esc(name)}</div>
        <div class="ch-sub">${sub}</div>
      </div>
      <div class="chat-header-actions">
        <button class="icon-btn" title="Действия с чатом" onclick="showChatCtx(event, ${chatId})">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
        </button>
      </div>
    </div>
    <div class="messages" id="messages"></div>
    <div id="typing-indicator" class="typing-indicator" style="display:none">
      <span class="typing-dots"><span></span><span></span><span></span></span>
      <span class="typing-name"></span><span class="typing-label"> печатает…</span>
    </div>
    <div class="chat-input-wrap" id="input-wrap">
      <div class="composer-inner">
        <div id="image-preview-bar" style="display:none" class="input-reply-bar">
          <img class="img-preview-thumb" src="" style="width:40px;height:40px;object-fit:cover;border-radius:6px;flex-shrink:0">
          <div class="reply-bar-content">
            <div class="reply-bar-name">Изображение</div>
            <div class="reply-bar-text img-preview-name"></div>
          </div>
          <button onclick="clearImagePreview()" class="icon-btn" style="width:24px;height:24px">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div id="reply-bar" style="display:none" class="input-reply-bar">
          <div class="reply-bar-content">
            <div class="reply-bar-name" id="reply-bar-name"></div>
            <div class="reply-bar-text" id="reply-bar-text"></div>
          </div>
          <button onclick="hideReplyBar()" class="icon-btn" style="width:24px;height:24px">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div id="edit-bar" style="display:none" class="input-edit-bar">
          <span>Редактирование</span>
          <button onclick="cancelEdit()" class="icon-btn" style="width:24px;height:24px;color:var(--accent)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="composer-pill" id="composer-pill">
          <button class="composer-icon-btn" title="Эмодзи" onclick="toggleEmojiPicker(event)">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 13s1.5 3 4 3 4-3 4-3"/><circle cx="9" cy="9" r="1" fill="currentColor"/><circle cx="15" cy="9" r="1" fill="currentColor"/></svg>
          </button>
          <button class="composer-icon-btn" title="Прикрепить изображение" onclick="pickImage()">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          </button>
          <input type="file" id="img-file-input" accept="image/*" style="display:none" onchange="onImagePicked(this)">
          <textarea id="msg-input" rows="1" placeholder="Сообщение…" onkeydown="handleKey(event)" oninput="onMsgInput(this)"></textarea>
          <button class="send-btn" id="send-btn" onclick="sendOrEdit()">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </button>
        </div>
      </div>
    </div>`;

  applyAvatars();
  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) { sendBtn.style.background='transparent'; sendBtn.style.color='var(--muted)'; sendBtn.style.boxShadow='none'; }
  if (S.ws && isViewing()) S.ws.send(JSON.stringify({type:'read', chat_id: chatId}));
  // Показать скелетон пока грузятся сообщения
  const msgsEl = document.getElementById('messages');
  if (msgsEl) {
    msgsEl.innerHTML = `<div class="skeleton-wrap">${[200,280,160,240,120].map((w,i) =>
      `<div class="skeleton-msg ${i%2===0?'theirs':'mine'}">
        <div class="skeleton-av"></div>
        <div class="skeleton-bubble" style="width:${w}px"></div>
      </div>`).join('')}</div>`;
  }
  const data = await api('GET', aroundId ? `/messages/chat/${chatId}?around=${aroundId}&limit=50` : `/messages/chat/${chatId}?limit=50`);
  // Игнорируем ответ если пока грузились — переключились на другой чат
  if (data && S.activeChatId === chatId) {
    S.chatHasMore = data.hasMore;
    S.chatHasMoreAfter = !!data.hasMoreAfter;
    S.chatOldestId = data.messages[0]?.id ?? null;
    S.chatNewestId = data.messages[data.messages.length - 1]?.id ?? null;
    renderMessages(data.messages, !aroundId);
    if (aroundId) {
      requestAnimationFrame(() => scrollToMsg(aroundId));
    } else {
      insertUnreadDivider(data.messages, _unreadAtOpen);
    }
    // Вешаем слушатель скролла для подгрузки старых сообщений
    const msgsEl = document.getElementById('messages');
    if (msgsEl) msgsEl.addEventListener('scroll', onMessagesScroll, { passive: true });
  }
  // Восстанавливаем сохранённый черновик этого чата
  const inputEl = document.getElementById('msg-input');
  if (inputEl && S.drafts[chatId]) {
    inputEl.value = S.drafts[chatId];
    autoResize(inputEl);
    onMsgInput(inputEl); // обновить состояние кнопки отправки
  }
  inputEl?.focus();
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
// Two messages are in the same "time group" if same sender and same HH:MM
function sameTimeGroup(a, b) {
  if (!a || !b) return false;
  if (a.sender_id !== b.sender_id) return false;
  const ta = new Date(a.sent_at * 1000), tb = new Date(b.sent_at * 1000);
  return ta.getHours() === tb.getHours() && ta.getMinutes() === tb.getMinutes() && ta.toDateString() === tb.toDateString();
}

// Разделитель «Непрочитанные сообщения» + скролл к нему (как в Telegram)
function insertUnreadDivider(msgs, unreadCount) {
  if (!unreadCount) return;
  const others = msgs.filter(m => m.sender_id !== S.user.id && !m.deleted);
  const firstUnread = others[others.length - unreadCount];
  if (!firstUnread) return;
  const el = document.querySelector(`[data-msg-id="${firstUnread.id}"]`);
  const container = document.getElementById('messages');
  if (!el || !container) return;
  const div = document.createElement('div');
  div.className = 'date-divider unread-divider';
  div.innerHTML = '<span>Непрочитанные сообщения</span>';
  el.parentNode.insertBefore(div, el);
  // Скроллим к разделителю после rAF-скролла renderMessages «в самый низ»
  requestAnimationFrame(() => {
    container.scrollTop = Math.max(div.offsetTop - 60, 0);
  });
}

function renderMessages(msgs, stick = true) {
  const container = document.getElementById('messages');
  if (!container) return;
  const chat = S.chats.find(c=>c.id===S.activeChatId);
  const isChatGroup = chat?.type==='group' || chat?.type==='room';
  msgs.forEach(m => { if (m.reactions?.length) S.reactions[m.id] = m.reactions; });
  let html = '';
  let lastDate = '';
  let lastSenderId = null;
  let lastSentAt = 0;
  msgs.forEach((m, i) => {
    const dateStr = fmtDate(m.sent_at);
    const dayChanged = dateStr !== lastDate;
    if (dayChanged) {
      html += `<div class="date-divider"><span>${dateStr}</span></div>`;
      lastDate = dateStr;
      lastSenderId = null; // reset grouping after day separator
    }
    // grouped = same sender as previous, within 5 minutes, no day break
    const grouped = !dayChanged && m.sender_id === lastSenderId && (m.sent_at - lastSentAt) < 300;
    const next = msgs[i + 1];
    const hideTime = !m.deleted && next && sameTimeGroup(m, next) && fmtDate(m.sent_at) === fmtDate(next.sent_at);
    const nextDayChanged = next ? fmtDate(next.sent_at) !== dateStr : true;
    const isLast = !next || nextDayChanged || next.sender_id !== m.sender_id || (next.sent_at - m.sent_at) >= 300;
    html += renderMsg(m, isChatGroup, hideTime, grouped, isLast);
    lastSenderId = m.sender_id;
    lastSentAt = m.sent_at;
  });
  container.innerHTML = html;
  if (stick) container.scrollTop = container.scrollHeight;
}

// ── PAGINATION: подгрузка старых сообщений ──
function onMessagesScroll() {
  const container = document.getElementById('messages');
  if (!container || _loadingMore) return;
  const dist = container.scrollHeight - container.scrollTop - container.clientHeight;
  if (S.chatHasMore && container.scrollTop < 80) loadMoreMessages();
  if (S.chatHasMoreAfter && dist < 80) loadMoreAfter();
}

async function loadMoreMessages() {
  if (_loadingMore || !S.chatHasMore || !S.activeChatId || !S.chatOldestId) return;
  _loadingMore = true;
  const chatId = S.activeChatId;
  const data = await api('GET', `/messages/chat/${chatId}?before=${S.chatOldestId}&limit=50`);
  _loadingMore = false;
  if (!data || S.activeChatId !== chatId) return;
  const { messages, hasMore } = data;
  if (!messages.length) { S.chatHasMore = false; return; }
  S.chatHasMore = hasMore;
  S.chatOldestId = messages[0].id;
  prependMessages(messages, chatId);
}

// Догрузка вниз — после перехода вглубь истории (поиск / цитата)
async function loadMoreAfter() {
  if (_loadingMore || !S.chatHasMoreAfter || !S.activeChatId || !S.chatNewestId) return;
  _loadingMore = true;
  const chatId = S.activeChatId;
  const data = await api('GET', `/messages/chat/${chatId}?after=${S.chatNewestId}&limit=50`);
  _loadingMore = false;
  if (!data || S.activeChatId !== chatId) return;
  S.chatHasMoreAfter = !!data.hasMoreAfter;
  if (!data.messages.length) return;
  S.chatNewestId = data.messages[data.messages.length - 1].id;
  appendMessagesAfter(data.messages, chatId);
}

function appendMessagesAfter(msgs, chatId) {
  const container = document.getElementById('messages');
  if (!container) return;
  const chat = S.chats.find(c => c.id === chatId);
  const isChatGroup = chat?.type === 'group' || chat?.type === 'room';
  msgs.forEach(m => { if (m.reactions?.length) S.reactions[m.id] = m.reactions; });
  // Продолжаем группировку от последнего отрендеренного сообщения
  const rendered = container.querySelectorAll('[data-msg-id]');
  const lastEl = rendered[rendered.length - 1];
  let lastDate = '', lastSenderId = null, lastSentAt = 0;
  if (lastEl) {
    lastSentAt = parseInt(lastEl.dataset.sentAt) || 0;
    lastSenderId = parseInt(lastEl.dataset.senderId) || null;
    lastDate = lastSentAt ? fmtDate(lastSentAt) : '';
  }
  let html = '';
  msgs.forEach((m, i) => {
    const dateStr = fmtDate(m.sent_at);
    const dayChanged = dateStr !== lastDate;
    if (dayChanged) { html += `<div class="date-divider"><span>${dateStr}</span></div>`; lastDate = dateStr; lastSenderId = null; }
    const grouped = !dayChanged && m.sender_id === lastSenderId && (m.sent_at - lastSentAt) < 300;
    const next = msgs[i + 1];
    const hideTime = !m.deleted && next && sameTimeGroup(m, next) && fmtDate(m.sent_at) === fmtDate(next.sent_at);
    const nextDayChanged = next ? fmtDate(next.sent_at) !== dateStr : true;
    const isLast = !next || nextDayChanged || next.sender_id !== m.sender_id || (next.sent_at - m.sent_at) >= 300;
    html += renderMsg(m, isChatGroup, hideTime, grouped, isLast);
    lastSenderId = m.sender_id; lastSentAt = m.sent_at;
  });
  container.insertAdjacentHTML('beforeend', html);
}

function prependMessages(msgs, chatId) {
  const container = document.getElementById('messages');
  if (!container) return;
  const chat = S.chats.find(c => c.id === chatId);
  const isChatGroup = chat?.type === 'group' || chat?.type === 'room';
  msgs.forEach(m => { if (m.reactions?.length) S.reactions[m.id] = m.reactions; });

  let html = '';
  let lastDate = '';
  let lastSenderId = null;
  let lastSentAt = 0;
  msgs.forEach((m, i) => {
    const dateStr = fmtDate(m.sent_at);
    const dayChanged = dateStr !== lastDate;
    if (dayChanged) {
      html += `<div class="date-divider"><span>${dateStr}</span></div>`;
      lastDate = dateStr;
      lastSenderId = null;
    }
    const grouped = !dayChanged && m.sender_id === lastSenderId && (m.sent_at - lastSentAt) < 300;
    const next = msgs[i + 1];
    const nextDayChanged = next ? fmtDate(next.sent_at) !== dateStr : true;
    const isLast = !next || nextDayChanged || next.sender_id !== m.sender_id || (next.sent_at - m.sent_at) >= 300;
    html += renderMsg(m, isChatGroup, false, grouped, isLast);
    lastSenderId = m.sender_id;
    lastSentAt = m.sent_at;
  });

  // Компенсируем скролл — чтобы экран не прыгал
  const prevHeight = container.scrollHeight;
  const prevTop = container.scrollTop;
  container.insertAdjacentHTML('afterbegin', html);
  container.scrollTop = prevTop + (container.scrollHeight - prevHeight);
}

function renderReactions(msgId) {
  const counts = S.reactions[msgId] || [];
  if (!counts.length) return '';
  return `<div class="reactions">${counts.map(r =>
    `<button class="reaction-btn" onclick="sendReaction(${msgId},'${r.reaction}')">${r.reaction} <span>${r.count}</span></button>`
  ).join('')}</div>`;
}

function renderMsg(m, isChatGroup, hideTime = false, grouped = false, isLast = true) {
  return renderMsgIRC(m, grouped);
}

function renderMsgIRC(m, isGroup) {
  const mine = m.sender_id===S.user.id;
  const time = fmtTime(m.sent_at);
  const isDeleted = m.deleted;
  const bodyText = isDeleted ? '<em class="irc-deleted">Сообщение удалено</em>' : linkifyText(m.text) + (m.edited_at?` <span class="edited-tag">изм.</span>`:'');
  const statusIcon = mine && !isDeleted ? renderStatus(m.status) : '';
  const reactionsHtml = isDeleted ? '' : renderReactions(m.id);
  const senderName = esc(m.sender_name);
  const avColor = avatarColor(m.sender_id);
  const avLetter = initials(m.sender_name).slice(0,1);
  const avImg = `<img src="${httpProto()}://${S.server}/api/users/${m.sender_id}/avatar" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:50%" onerror="this.style.display='none'">`;
  const replyHtml = m.reply_to_id ? `
    <div style="border-left:2px solid var(--accent);padding:2px 0 2px 10px;margin-bottom:4px;color:var(--muted);font-size:13px" onclick="scrollToMsg(${m.reply_to_id})">
      <span style="color:var(--accent);font-weight:600;margin-right:6px">↳ ${esc(m.reply_sender_name || '')}</span>
      <span style="opacity:.8">${m.reply_deleted ? 'Сообщение удалено' : esc((m.reply_text||'').slice(0,80))}</span>
    </div>` : '';

  // Hover action panel (shown on :hover via CSS)
  const actionsHtml = isDeleted ? '' : `
    <div class="irc-actions">
      <button class="irc-action-btn" data-mid="${m.id}" data-r="👍" onclick="sendReaction(+this.dataset.mid,this.dataset.r)" title="👍">👍</button>
      <button class="irc-action-btn" data-mid="${m.id}" data-r="❤️" onclick="sendReaction(+this.dataset.mid,this.dataset.r)" title="❤️">❤️</button>
      <button class="irc-action-btn" data-mid="${m.id}" data-r="😂" onclick="sendReaction(+this.dataset.mid,this.dataset.r)" title="😂">😂</button>
      <button class="irc-action-btn" data-mid="${m.id}" data-r="👎" onclick="sendReaction(+this.dataset.mid,this.dataset.r)" title="👎">👎</button>
      <span style="width:1px;background:var(--border);margin:3px 2px;align-self:stretch"></span>
      <button class="irc-action-btn" onclick="dblReply(${m.id})" title="Ответить">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
      </button>
    </div>`;

  const avCol = isGroup
    ? `<div style="width:28px;flex-shrink:0"></div>`
    : `<div class="irc-av av av-round ${avColor}" style="position:relative;flex-shrink:0">${avLetter}${avImg}</div>`;

  const ircTagHtml = (!isGroup && m.sender_tag) ? `<span class="bubble-tag bubble-tag-${avColor.replace('av-','')}" style="margin-left:6px">${esc(m.sender_tag)}</span>` : '';
  const header = isGroup
    ? `<div class="irc-header irc-header-grouped">
        <div class="irc-meta"><span class="status-wrap">${statusIcon}</span><span class="irc-time">${time}</span></div>
       </div>`
    : `<div class="irc-header">
        <div style="display:flex;align-items:center;flex:1;min-width:0">
          <span class="irc-name ${avColor}-text${mine?' mine':''}">${senderName}</span>${ircTagHtml}
        </div>
        <div class="irc-meta"><span class="status-wrap">${statusIcon}</span><span class="irc-time">${time}</span></div>
       </div>`;

  const att = m.attachment;
  const attachHtml = (!isDeleted && att?.url) ? `<div class="bubble-image" style="margin:4px 0;max-width:260px" onclick="openLightbox('${httpProto()}://${S.server}${att.url}')"><img src="${httpProto()}://${S.server}${att.thumb || att.url}" loading="lazy"></div>` : '';

  return `<div class="irc-msg${isGroup?' irc-grouped':''}${m._optimistic?' msg-optimistic':''}" data-msg-id="${m.id}" data-sender-id="${m.sender_id}" data-sent-at="${m.sent_at}"${m._optimistic?' data-optimistic="1"':''}
    oncontextmenu="${!isDeleted?`showCtxMenu(event,${m.id},${m.sent_at},${mine})`:'event.preventDefault()'}">
    ${avCol}
    <div class="irc-content" ondblclick="${!isDeleted?`dblReply(${m.id})`:''}">
      ${header}
      ${replyHtml}
      ${attachHtml}
      ${m.text || isDeleted ? `<div class="irc-text${isDeleted?' irc-deleted':''}">${bodyText}</div>` : ''}
      ${reactionsHtml}
    </div>
    ${actionsHtml}
  </div>`;
}

function renderStatus(status) {
  if (!status) return '';
  const { delivered, read, total } = status;
  if (total === 0) return '';
  let cls, title;
  // «Прочитано» (синие галочки) — только когда прочитали ВСЕ получатели.
  // В группе при частичном прочтении показываем «Прочитано N из total».
  if (read >= total)      { cls = 'status-read';       title = 'Прочитано'; }
  else if (read > 0)      { cls = 'status-delivered';  title = `Прочитано ${read} из ${total}`; }
  else if (delivered > 0) { cls = 'status-delivered';  title = 'Доставлено'; }
  else                    { cls = 'status-sent';        title = 'Отправлено'; }
  const double = delivered > 0 || read > 0;
  return `<span class="msg-status ${cls}" title="${title}">
    <svg width="13" height="9" viewBox="0 0 18 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      ${double
        ? '<polyline points="1,5.5 3.5,8 9,1"/><polyline points="7,5.5 9.5,8 15,1"/>'
        : '<polyline points="7,5.5 9.5,8 15,1"/>'}
    </svg>
  </span>`;
}

function appendMsg(m) {
  const container = document.getElementById('messages');
  if (!container) return;
  const chat = S.chats.find(c=>c.id===S.activeChatId);
  const allMsgs = [...container.querySelectorAll('[data-msg-id]')];
  const lastEl = allMsgs[allMsgs.length - 1];
  let grouped = false;
  if (lastEl && !m.deleted) {
    const prevSenderId = parseInt(lastEl.dataset.senderId || '0');
    const prevTime = parseInt(lastEl.dataset.sentAt || '0');
    grouped = sameTimeGroup({ sender_id: prevSenderId, sent_at: prevTime }, m);
  }
  if (lastEl && grouped) {
    const lastBubble = lastEl.querySelector('.bubble');
    if (lastBubble) {
      lastBubble.classList.remove('bubble-last');
      if (!lastBubble.classList.contains('bubble-first') && !lastBubble.classList.contains('bubble-mid')) {
        lastBubble.classList.add('bubble-first');
      } else if (lastBubble.classList.contains('bubble-last')) {
        lastBubble.classList.remove('bubble-last');
        lastBubble.classList.add('bubble-mid');
      }
      const lastAvatar = lastEl.querySelector('.av.av-sm');
      if (lastAvatar) lastAvatar.style.display = 'none';
      const lastPlaceholder = lastEl.querySelector('[style*="width:32px"]');
      // placeholder already there if not last
    }
  }
  const isChatGroupAppend = chat?.type==='group' || chat?.type==='room';
  container.insertAdjacentHTML('beforeend', renderMsg(m, isChatGroupAppend, false, grouped, true));
  const newEl = container.lastElementChild;
  if (newEl && !m._optimistic) newEl.classList.add('msg-new');

  // Умный скролл: прокручиваем только если пользователь у дна
  const dist = container.scrollHeight - container.scrollTop - container.clientHeight;
  if (dist < 120) {
    container.scrollTo({ top: container.scrollHeight, behavior: m._optimistic ? 'instant' : 'smooth' });
  }
}

function updateMsgInDOM(m) {
  const el = document.querySelector(`[data-msg-id="${m.id}"]`);
  if (!el) return;
  const chat = S.chats.find(c=>c.id===S.activeChatId);
  el.outerHTML = renderMsg(m, chat?.type==='group' || chat?.type==='room');
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

// ── TYPING ──
const typingTimers = {}; // chatId -> clearTimeout handle
let typingSendTimer = null;

function onMsgInput(el) {
  autoResize(el);
  // Сохраняем черновик для текущего чата, чтобы он не терялся при переключении
  if (S.activeChatId) {
    if (el.value) S.drafts[S.activeChatId] = el.value;
    else delete S.drafts[S.activeChatId];
    saveDrafts();
  }
  if (!S.activeChatId || S.ws?.readyState !== 1) return;
  if (!typingSendTimer) {
    S.ws.send(JSON.stringify({ type: 'typing', chat_id: S.activeChatId }));
  }
  clearTimeout(typingSendTimer);
  typingSendTimer = setTimeout(() => { typingSendTimer = null; }, 1000);
  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) {
    const hasDraft = el.value.trim().length > 0;
    sendBtn.style.background = hasDraft ? 'var(--accent)' : 'transparent';
    sendBtn.style.color = hasDraft ? '#fff' : 'var(--muted)';
    sendBtn.style.boxShadow = hasDraft ? '0 6px 16px var(--accent-shadow)' : 'none';
  }
}

function showTyping(chatId, senderName) {
  if (typingTimers[chatId]) clearTimeout(typingTimers[chatId]);
  if (chatId === S.activeChatId) {
    const el = document.getElementById('typing-indicator');
    if (el) { el.style.display = 'flex'; el.querySelector('.typing-name').textContent = senderName; }
  }
  // Show in chat list
  const item = document.querySelector(`.chat-item[data-chat-id="${chatId}"] .ci-last`);
  if (item) { item.dataset.origText = item.dataset.origText || item.textContent; item.textContent = `${senderName} печатает…`; item.classList.add('typing-preview'); }

  typingTimers[chatId] = setTimeout(() => {
    clearTyping(chatId);
  }, 5000);
}

function clearTyping(chatId) {
  delete typingTimers[chatId];
  if (chatId === S.activeChatId) {
    const el = document.getElementById('typing-indicator');
    if (el) el.style.display = 'none';
  }
  const item = document.querySelector(`.chat-item[data-chat-id="${chatId}"] .ci-last`);
  if (item && item.dataset.origText !== undefined) {
    item.textContent = item.dataset.origText;
    delete item.dataset.origText;
    item.classList.remove('typing-preview');
  }
}
function autoResize(el) {
  el.style.overflow = 'hidden';
  el.style.height = '20px'; // min = одна строка
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  if (el.scrollHeight > 120) el.style.overflow = 'auto';
}

function sendOrEdit() {
  if (S.editingMessageId) { submitEdit(); return; }
  const input = document.getElementById('msg-input');
  const text = input?.value.trim();
  if (!text && !_pendingAttachment) return;
  if (!S.ws||S.ws.readyState!==1) return;
  const payload = { type:'message', chat_id:S.activeChatId, text: text || '' };
  if (S.replyTo) payload.reply_to_id = S.replyTo.id;
  if (_pendingAttachment) payload.attachment = _pendingAttachment;

  // Optimistic: показать сообщение сразу, не дожидаясь echo от сервера
  const tempMsg = {
    id: -(Date.now()),
    chat_id: S.activeChatId,
    sender_id: S.user.id,
    sender_name: S.user.display_name,
    text: text || '',
    sent_at: Math.floor(Date.now() / 1000),
    edited_at: null,
    deleted: 0,
    reply_to_id: S.replyTo?.id || null,
    reply_text: S.replyTo?.text || null,
    reply_sender_name: S.replyTo?.senderName || null,
    reply_deleted: false,
    attachment: _pendingAttachment || null,
    status: { delivered: 0, read: 0, total: 1 },
    reactions: [],
    _optimistic: true,
  };
  if (!S.chatHasMoreAfter) appendMsg(tempMsg);

  S.ws.send(JSON.stringify(payload));
  if (S.chatHasMoreAfter) openChat(S.activeChatId); // мы были вглуби истории — к последним
  hideReplyBar();
  clearImagePreview();
  delete S.drafts[S.activeChatId]; saveDrafts(); // черновик отправлен — очищаем
  input.value=''; input.style.height='20px'; input.style.overflow='hidden';
  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) { sendBtn.style.background='transparent'; sendBtn.style.color='var(--muted)'; sendBtn.style.boxShadow='none'; }
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
  hideReplyBar();
  const input = document.getElementById('msg-input');
  if (input) { input.value=''; input.style.height='auto'; }
}

// ── CONTEXT MENU ──
function showCtxMenu(e, msgId, sentAt, isMine) {
  e.preventDefault(); e.stopPropagation();
  S.ctx.messageId = msgId;
  S.ctx.canEdit = isMine && (Date.now()/1000 - sentAt) < (S.editLimit || 120);
  S.ctx.isMine = isMine;
  const menu = document.getElementById('ctx-menu');
  document.getElementById('ctx-reply-btn').style.display = '';
  document.getElementById('ctx-copy-btn').style.display = '';
  document.getElementById('ctx-edit-btn').style.display = (isMine && S.ctx.canEdit) ? '' : 'none';
  document.getElementById('ctx-delete-btn').style.display = isMine ? '' : 'none';
  document.getElementById('ctx-info-btn').style.display = isMine ? '' : 'none';
  // Сначала показываем чтобы получить реальные размеры
  menu.style.top = '-9999px'; menu.style.left = '-9999px';
  menu.classList.add('open');
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const margin = 6;
  let x = e.clientX, y = e.clientY;
  if (x + mw + margin > window.innerWidth)  x = window.innerWidth  - mw - margin;
  if (y + mh + margin > window.innerHeight) y = e.clientY - mh; // открываем вверх
  if (y < margin) y = margin;
  if (x < margin) x = margin;
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}

function dblReply(msgId) {
  S.ctx.messageId = msgId;
  ctxReply();
}

function ctxCopy() {
  hideCtxMenu();
  const msgId = S.ctx.messageId;
  if (!msgId) return;
  const el = document.querySelector(`[data-msg-id="${msgId}"] .bubble-text`)
           || document.querySelector(`[data-msg-id="${msgId}"] .irc-text`);
  if (!el) return;
  navigator.clipboard.writeText(el.innerText).catch(() => {});
}

function ctxReply() {
  hideCtxMenu();
  const msgId = S.ctx.messageId;
  if (!msgId) return;
  const bubbleEl = document.querySelector(`[data-msg-id="${msgId}"] .bubble-text`) || document.querySelector(`[data-msg-id="${msgId}"] .irc-text`);
  const text = bubbleEl?.innerText || '';
  const msgEl = document.querySelector(`[data-msg-id="${msgId}"]`);
  const senderIdAttr = parseInt(msgEl?.dataset.senderId || '0');
  let senderName;
  if (senderIdAttr === S.user.id) {
    senderName = S.user.display_name;
  } else {
    const u = S.allUsers.find(u => u.id === senderIdAttr);
    senderName = u?.display_name || '';
  }
  S.replyTo = { id: msgId, text: text.slice(0, 100), senderName };
  showReplyBar();
}

function showReplyBar() {
  const bar = document.getElementById('reply-bar');
  if (!bar || !S.replyTo) return;
  document.getElementById('reply-bar-name').textContent = S.replyTo.senderName;
  document.getElementById('reply-bar-text').textContent = S.replyTo.text;
  bar.style.display = '';
  document.getElementById('composer-pill')?.classList.add('has-reply');
  document.getElementById('msg-input')?.focus();
}

function hideReplyBar() {
  S.replyTo = null;
  const bar = document.getElementById('reply-bar');
  if (bar) bar.style.display = 'none';
  document.getElementById('composer-pill')?.classList.remove('has-reply');
}

// ── IMAGE ATTACH ──
let _pendingAttachment = null;

function pickImage() {
  document.getElementById('img-file-input')?.click();
}

async function onImagePicked(input) {
  const file = input.files?.[0];
  if (!file) return;
  input.value = '';
  await uploadImageFile(file);
}

async function uploadImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return;

  const formData = new FormData();
  formData.append('file', file);

  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) { sendBtn.style.background='var(--accent)'; sendBtn.style.color='#fff'; sendBtn.style.boxShadow='0 6px 16px var(--accent-shadow)'; }

  try {
    const res = await fetch(`${httpProto()}://${S.server}/api/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${S.token}` },
      body: formData,
    });
    if (!res.ok) throw new Error('upload failed');
    _pendingAttachment = await res.json();
    showImagePreviewBar();
  } catch {
    if (sendBtn && !document.getElementById('msg-input')?.value.trim()) {
      sendBtn.style.background='transparent'; sendBtn.style.color='var(--muted)'; sendBtn.style.boxShadow='none';
    }
  }
}

function showImagePreviewBar() {
  let bar = document.getElementById('image-preview-bar');
  if (!bar) return;
  const att = _pendingAttachment;
  if (!att) { bar.style.display = 'none'; return; }
  bar.style.display = '';
  bar.querySelector('.img-preview-thumb').src = `${httpProto()}://${S.server}${att.url}`;
  bar.querySelector('.img-preview-name').textContent = att.name || 'Изображение';
}

function clearImagePreview() {
  _pendingAttachment = null;
  const bar = document.getElementById('image-preview-bar');
  if (bar) bar.style.display = 'none';
  const sendBtn = document.getElementById('send-btn');
  if (sendBtn && !document.getElementById('msg-input')?.value.trim()) {
    sendBtn.style.background='transparent'; sendBtn.style.color='var(--muted)'; sendBtn.style.boxShadow='none';
  }
}

function openLightbox(url) {
  let lb = document.getElementById('lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'lightbox';
    lb.onclick = () => closeLightbox();
    lb.innerHTML = '<img id="lightbox-img">';
    document.body.appendChild(lb);
  }
  document.getElementById('lightbox-img').src = url;
  lb.classList.remove('lb-closing');
  lb.classList.add('lb-open');
}
function closeLightbox() {
  const lb = document.getElementById('lightbox');
  if (!lb || lb.classList.contains('lb-closing')) return;
  lb.classList.remove('lb-open');
  lb.classList.add('lb-closing');
  const onEnd = e => {
    if (e.target !== lb) return;
    lb.classList.remove('lb-closing');
    lb.removeEventListener('animationend', onEnd);
  };
  lb.addEventListener('animationend', onEnd);
}

function scrollToMsg(msgId) {
  const el = document.querySelector(`[data-msg-id="${msgId}"]`);
  // Сообщения нет в DOM (глубоко в истории) — перезагружаем чат окном вокруг него
  if (!el) { if (S.activeChatId) openChat(S.activeChatId, msgId); return; }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('msg-highlight');
  setTimeout(() => el.classList.remove('msg-highlight'), 1500);
}
function hideCtxMenu() {
  document.getElementById('ctx-menu').classList.remove('open');
}

function ctxEdit() {
  hideCtxMenu();
  if (!S.ctx.canEdit) return;
  const el = document.querySelector(`[data-msg-id="${S.ctx.messageId}"] .bubble-text`)
           || document.querySelector(`[data-msg-id="${S.ctx.messageId}"] .irc-text`);
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

  let body = `<div class="msg-info-row"><span class="msg-info-label">Отправлено</span><span class="msg-info-val">${fmtDt(data.sent_at)}</span></div>`;

  if (data.chat_type === 'direct') {
    const s = data.statuses[0];
    body += `<div class="msg-info-row"><span class="msg-info-label">Доставлено</span><span class="msg-info-val">${fmtDt(s?.delivered_at)}</span></div>`;
    body += `<div class="msg-info-row"><span class="msg-info-label">Прочитано</span><span class="msg-info-val">${fmtDt(s?.read_at)}</span></div>`;
  } else {
    const readUsers = data.statuses.filter(s => s.read_at);
    const unreadUsers = data.statuses.filter(s => !s.read_at);
    if (readUsers.length) {
      body += `<div class="msg-info-label" style="padding:0 2px">Прочитали</div>`;
      body += readUsers.map(s => `<div class="msg-info-user-row">
        <div style="font-size:13px;font-weight:500">${esc(s.display_name)}</div>
        <div style="font-size:12px;color:var(--muted)">${fmtDt(s.read_at)}</div>
      </div>`).join('');
    }
    if (unreadUsers.length) {
      body += `<div class="msg-info-label" style="padding:${readUsers.length?'8px':'0'} 2px 0">Не прочитали</div>`;
      body += unreadUsers.map(s => `<div class="msg-info-user-row">
        <div style="font-size:13px;color:var(--muted)">${esc(s.display_name)}</div>
      </div>`).join('');
    }
    if (!data.statuses.length) {
      body += `<div style="text-align:center;padding:16px;color:var(--muted);font-size:13px">Никто ещё не прочитал</div>`;
    }
  }

  document.getElementById('msg-info-body').innerHTML = body;
  openModal('modal-msg-info');
}

// ── CUSTOM CONFIRM (replaces native confirm to avoid Electron focus bug on Windows) ──
let _confirmCallback = null;
function showConfirm(text, okLabel = 'Удалить') {
  return new Promise(resolve => {
    _confirmCallback = resolve;
    document.getElementById('confirm-body').textContent = text;
    document.getElementById('confirm-ok').textContent = okLabel;
    document.getElementById('modal-confirm').classList.add('open');
  });
}
function _confirmResolve() {
  document.getElementById('modal-confirm').classList.remove('open');
  if (_confirmCallback) { _confirmCallback(true); _confirmCallback = null; }
}
function _confirmReject() {
  document.getElementById('modal-confirm').classList.remove('open');
  if (_confirmCallback) { _confirmCallback(false); _confirmCallback = null; }
}

// ── DELETE CHAT / LEAVE GROUP ──
async function deleteChat(chatId) {
  const ok = await showConfirm('Удалить чат? Для вас он исчезнет из списка.');
  if (!ok) return;
  await api('DELETE', `/chats/${chatId}`);
  removeChatLocally(chatId);
}

function removeChatLocally(chatId) {
  S.chats = S.chats.filter(c=>c.id!==chatId);
  if (S.activeChatId === chatId) {
    S.activeChatId = null;
    document.getElementById('chat-main').innerHTML = `<div class="empty-state"><div class="empty-icon">💬</div><div class="empty-title">Electron</div><div class="empty-sub">Выберите чат или создайте новый</div></div>`;
  }
  renderChatList();
}

function openGroupMembers(chatId) {
  const chat = S.chats.find(c=>c.id===chatId);
  if (!chat) return;
  const isCreator = chat.created_by === S.user.id;
  const isAdmin = S.user.is_admin;
  const canManage = isCreator || isAdmin;

  function renderGmList() {
    const c = S.chats.find(x=>x.id===chatId);
    document.getElementById('gm-list').innerHTML = (c?.members||[]).map(m => {
      const isOwner = c.created_by === m.id;
      const kickBtn = canManage && !isOwner ? `
        <button onclick="kickMember(${chatId},${m.id})" title="Исключить"
          style="margin-left:auto;border:none;background:none;cursor:pointer;color:var(--muted);padding:4px;border-radius:6px;display:flex;align-items:center"
          onmouseover="this.style.color='var(--danger,#e05)'" onmouseout="this.style.color='var(--muted)'">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
            <line x1="17" y1="11" x2="23" y2="11"/>
          </svg>
        </button>` : (isOwner ? `<span style="margin-left:auto;font-size:11px;color:var(--muted);background:var(--card-bg);padding:2px 8px;border-radius:10px">создатель</span>` : '');
      return `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid var(--border)">
          <div class="av av-sm av-round ${avatarColor(m.id)}" data-av-user="${m.id}">${initials(m.display_name)}</div>
          <div>
            <div style="font-size:14px;font-weight:500">${esc(m.display_name)}</div>
            <div style="font-size:12px;color:var(--muted)">@${esc(m.username)}</div>
          </div>
          ${kickBtn}
        </div>`;
    }).join('') || '<div style="color:var(--muted);text-align:center;padding:20px">Нет участников</div>';

    if (canManage) {
      document.getElementById('gm-list').insertAdjacentHTML('beforeend', `
        <div style="padding:10px 4px 4px">
          <button onclick="openAddMember(${chatId})" class="modal-btn-primary" style="width:100%">+ Добавить участника</button>
        </div>`);
    }
    applyAvatars();
  }

  document.getElementById('gm-title').textContent = chatName(chat);
  renderGmList();
  openModal('modal-group-members');
}

async function kickMember(chatId, userId) {
  const ok = await showConfirm('Исключить участника из группы?', 'Исключить');
  if (!ok) return;
  const res = await api('DELETE', `/chats/${chatId}/members/${userId}`);
  if (res.ok) {
    await loadChats();
    openGroupMembers(chatId);
  }
}

async function openAddMember(chatId) {
  const chat = S.chats.find(c=>c.id===chatId);
  const memberIds = new Set((chat?.members||[]).map(m=>m.id));
  const all = await api('GET', '/users');
  const available = all.filter(u => !memberIds.has(u.id));
  if (!available.length) { await showConfirm('Все пользователи уже в группе', 'OK'); return; }

  // Показываем список для добавления прямо в модальном окне
  const list = document.getElementById('gm-list');
  list.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 4px 12px;border-bottom:1px solid var(--border)">
      <button onclick="openGroupMembers(${chatId})" class="modal-btn-primary" style="flex-shrink:0">← Назад</button>
      <span style="font-size:13px;color:var(--muted)">Выберите пользователя</span>
    </div>
    ${available.map(u => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid var(--border);cursor:pointer"
           onclick="addMember(${chatId},${u.id})"
           onmouseover="this.style.background='var(--hover-row)'" onmouseout="this.style.background=''">
        <div class="av av-sm av-round ${avatarColor(u.id)}" data-av-user="${u.id}">${initials(u.display_name)}</div>
        <div>
          <div style="font-size:14px;font-weight:500">${esc(u.display_name)}</div>
          <div style="font-size:12px;color:var(--muted)">@${esc(u.username)}</div>
        </div>
      </div>`).join('')}`;
  applyAvatars();
}

async function addMember(chatId, userId) {
  await api('POST', `/chats/${chatId}/members`, { user_id: userId });
  await loadChats();
  openGroupMembers(chatId);
}

async function leaveGroup(chatId) {
  const ok = await showConfirm('Выйти из группы?', 'Выйти');
  if (!ok) return;
  await api('POST', `/chats/${chatId}/leave`);
  S.activeChatId = null;
  document.getElementById('chat-main').innerHTML = `<div class="empty-state"><div class="empty-icon">💬</div><div class="empty-title">Electron</div><div class="empty-sub">Выберите чат или создайте новый</div></div>`;
  loadChats();
}

// ── WEBSOCKET ──
function connectWS() {
  const ws = new WebSocket(`${wsProto()}://${S.server}/ws?token=${S.token}`);
  S.ws = ws;

  ws.onmessage = async e => {
    let data; try { data=JSON.parse(e.data); } catch { return; }

    if (data.type==='connected') { S.editLimit = data.edit_time_limit || 120; return; }

    if (data.type==='message') {
      const { message } = data;
      const chatId = message.chat_id;
      const chat = S.chats.find(c=>c.id===chatId);
      if (chat) chat.last_message = message;
      // Если мы вглуби истории (низ не догружен) — не аппендим, придёт при догрузке
      if (S.activeChatId===chatId && !S.chatHasMoreAfter) {
        // Убираем optimistic-заглушку если она есть (только для своих сообщений)
        if (message.sender_id === S.user.id) {
          document.querySelector('[data-optimistic="1"]')?.remove();
        }
        appendMsg(message);
        S.chatNewestId = message.id;
        if (isViewing() && S.ws?.readyState===1) {
          // Пользователь смотрит в чат — отмечаем прочитанным
          S.ws.send(JSON.stringify({type:'read', chat_id:chatId}));
          S.ws.send(JSON.stringify({type:'delivered', message_id:message.id}));
        } else if (!isViewing() && message.sender_id !== S.user.id) {
          // Окно скрыто/свёрнуто — уведомляем, не отмечаем прочитанным
          S.unread[chatId] = (S.unread[chatId]||0)+1;
          const title = chatName(chat) || 'Electron';
          const body = `${message.sender_name}: ${message.text || (message.attachment ? '🖼 Изображение' : '')}`;
          window.electron?.notify(title, body, chatId);
          playNotificationSound();
          if (S.ws?.readyState===1) S.ws.send(JSON.stringify({type:'delivered', message_id:message.id}));
        }
      } else if (message.sender_id === S.user.id) {
        // Своё сообщение, отправленное с другого устройства — чат прочитан мной
        S.unread[chatId] = 0;
      } else {
        S.unread[chatId] = (S.unread[chatId]||0)+1;
        const chat2 = S.chats.find(c=>c.id===chatId);
        const title = chatName(chat2) || 'Electron';
        const body = `${message.sender_name}: ${message.text || (message.attachment ? '🖼 Изображение' : '')}`;
        window.electron?.notify(title, body, chatId);
        playNotificationSound();
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
      if (chat?.last_message?.id===message_id) chat.last_message = {...chat.last_message, deleted:1, text:'', attachment:null};
      if (S.activeChatId===chat_id) {
        const el = document.querySelector(`[data-msg-id="${message_id}"]`);
        if (el) {
          const isChatGroup = chat?.type==='group' || chat?.type==='room';
          const grouped = el.classList.contains('grouped') || el.classList.contains('irc-grouped');
          const fakeMsg = { id:message_id, deleted:1, text:'', attachment:null,
            sender_id:Number(el.dataset.senderId), sender_name:'', sent_at:Number(el.dataset.sentAt),
            reply_to_id:null, edited_at:null, status:{delivered:0,read:0,total:0}, reactions:[] };
          const isLastDeleted = !el.nextElementSibling || !el.nextElementSibling.dataset.msgId || el.nextElementSibling.dataset.senderId !== el.dataset.senderId;
          el.outerHTML = renderMsg(fakeMsg, isChatGroup, false, grouped, isLastDeleted);
        }
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

    if (data.type==='chat_read') {
      // Чат прочитан на другом устройстве этого пользователя
      S.unread[data.chat_id] = 0;
      updateUnreadTotal();
      renderChatList();
    }

    if (data.type==='chat_cleared') {
      const chat = S.chats.find(c => c.id === data.chat_id);
      if (chat) { chat.last_message = null; renderChatList(); }
      // Если чат открыт — очищаем историю сообщений на экране
      if (S.activeChatId === data.chat_id) {
        S.messages = [];
        S.chatHasMore = false;
        S.chatOldestId = null;
        const container = document.getElementById('messages');
        if (container) container.innerHTML = '';
      }
    }

    if (data.type==='reaction_update') {
      const { message_id, counts } = data;
      S.reactions[message_id] = counts;
      if (S.activeChatId) {
        const msgEl = document.querySelector(`[data-msg-id="${message_id}"]`);
        if (msgEl) {
          const container = document.getElementById('messages');
          const prevScrollHeight = container?.scrollHeight || 0;
          const isAtBottom = container && (container.scrollHeight - container.scrollTop - container.clientHeight < 10);

          const existing = msgEl.querySelector('.reactions');
          const reactionsHtml = renderReactions(message_id);
          if (existing) {
            existing.outerHTML = reactionsHtml || '';
          } else if (reactionsHtml) {
            const target = msgEl.querySelector('.msg-bubble-row') || msgEl.querySelector('.irc-content');
            if (target) target.insertAdjacentHTML('beforeend', reactionsHtml);
          }

          if (container) {
            const delta = container.scrollHeight - prevScrollHeight;
            if (isAtBottom) {
              // Были у дна — остаёмся у дна
              container.scrollTop = container.scrollHeight;
            } else if (delta > 0) {
              // Компенсируем сдвиг: прокручиваем вверх на высоту добавленного элемента,
              // чтобы сообщения ниже реакции остались на месте
              container.scrollTop += delta;
            }
          }
        }
      }
    }

    if (data.type==='typing') {
      showTyping(data.chat_id, data.sender_name);
    }

    if (data.type==='presence') {
      S.presence[data.user_id] = data.status;
      if (data.last_seen) S.lastSeen[data.user_id] = data.last_seen;
      // Обновляем подпись в шапке открытого личного чата («в сети» / «был(а) в …»)
      const activeChat = S.chats.find(c=>c.id===S.activeChatId);
      if (activeChat?.type === 'direct' && getPeerUserId(activeChat) === data.user_id) {
        const subEl = document.querySelector('.ch-sub');
        if (subEl) subEl.textContent = peerStatusText(data.user_id);
      }
      const color = data.status==='online'?'#22c55e':data.status==='away'?'#eab308':'#ef4444';
      // Точечно обновляем все presence-dot с этим user_id — без полного renderChatList
      document.querySelectorAll(`.presence-dot[data-user-id="${data.user_id}"]`).forEach(dot => {
        dot.style.background = color;
        dot.title = data.status;
      });
      if (S.activeChatId) {
        const chat = S.chats.find(c=>c.id===S.activeChatId);
        if (chat && getPeerUserId(chat) === data.user_id) {
          const dotEl = document.querySelector('.chat-header .presence-dot');
          if (dotEl) { dotEl.style.background = color; dotEl.title = data.status; }
        }
      }
    }

    if (data.type==='status_update') {
      const m = data.message;
      if (S.activeChatId===m.chat_id && m.sender_id===S.user.id) {
        const wrap = document.querySelector(`[data-msg-id="${m.id}"] .status-wrap`);
        if (wrap) wrap.innerHTML = renderStatus(m.status);
      }
    }

    if (data.type==='edit_rejected') {
      // Сервер отклонил редактирование (вышло время) — сообщаем и закрываем режим правки
      if (S.editingMessageId === data.message_id) cancelEdit();
      showActionToast(data.reason === 'time'
        ? `Редактировать можно только в течение ${formatEditLimit(S.editLimit || 120)}`
        : 'Не удалось отредактировать сообщение');
    }

    if (data.type==='avatar_updated') {
      S.avatarTs = Date.now();
      _avatarCache.clear();
      updateMeAvatar();
      renderChatList();
    }

    if (data.type === 'force_update') {
      // Сервер присылает готовый downloadUrl для нашей платформы.
      // Если по какой-то причине не прислал — ищем сами через GitHub API.
      if (data.downloadUrl) {
        _updateDownloadUrl = data.downloadUrl;
        forceInstallUpdate();
      } else {
        checkUpdateForced().then(() => {
          if (_updateDownloadUrl) forceInstallUpdate();
          else showActionToast('Обновление недоступно: файл не найден в релизе');
        });
      }
    }

    if (data.type === 'force_logout') {
      logout();
    }
  };

  ws.onclose = () => {
    S.wsRetry++;
    const delay = Math.min(1000*S.wsRetry, 10000);
    if (S.token) {
      showServerToast();
      setTimeout(connectWS, delay);
    }
  };
  ws.onopen = async () => {
    S.wsRetry = 0;
    hideServerToast();
    loadChats();
    // Delay status send: at launch document.hidden may still be true while window is appearing
    setTimeout(() => {
      const initStatus = document.hidden ? 'away' : 'online';
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'set_status', status: initStatus }));
      updateSidebarStatus(initStatus);
    }, 300);
    // Отправить метаданные клиента
    try {
      const version = await window.electron?.getVersion?.() || '';
      const hostname = await window.electron?.getHostname?.() || '';
      const osInfo = await window.electron?.getOS?.() || {};
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'client_info', clientVersion: version, hostname, osPlatform: osInfo.platform || '', osRelease: osInfo.release || '', installScope: osInfo.installScope || null }));
    } catch {}
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
  if (data) {
    S.presence = {}; S.lastSeen = {};
    for (const [id, v] of Object.entries(data)) {
      if (v && typeof v === 'object') { S.presence[id] = v.status; if (v.last_seen) S.lastSeen[id] = v.last_seen; }
      else S.presence[id] = v; // совместимость со старым сервером
    }
    renderChatList();
  }
}

// Текст статуса собеседника для шапки чата (как в Telegram)
function peerStatusText(userId) {
  const st = S.presence[userId] || 'offline';
  if (st === 'online') return 'в сети';
  if (st === 'away') return 'отошёл';
  const ts = S.lastSeen[userId];
  if (!ts) return 'не в сети';
  const d = new Date(ts * 1000), now = new Date();
  const time = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `был(а) в ${time}`;
  return `был(а) ${d.toLocaleDateString('ru', { day: 'numeric', month: 'short' })} в ${time}`;
}

function presenceDot(userId) {
  const s = S.presence[userId] || 'offline';
  const color = s === 'online' ? '#22c55e' : s === 'away' ? '#eab308' : '#ef4444';
  return `<span class="presence-dot" data-user-id="${userId}" style="background:${color}" title="${s}"></span>`;
}

function getPeerUserId(chat) {
  if (chat.type !== 'direct') return null;
  return chat.members?.find(m => m.id !== S.user.id)?.id || null;
}

function triggerGroupAvatarUpload() { document.getElementById('group-avatar-input').click(); }
async function onGroupAvatarChange(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    S.newGroupAvatarBase64 = e.target.result.split(',')[1];
    const el = document.getElementById('new-group-av');
    el.style.backgroundImage = `url('${e.target.result}')`;
    el.style.backgroundSize = 'cover';
    el.textContent = '';
  };
  reader.readAsDataURL(file);
}

// ── NEW CHAT MODAL ──
function openNewChat() {
  switchTab('direct');
  renderModalUsers('tab-direct', false);
  renderModalUsers('tab-group', true);
  document.getElementById('group-name').value='';
  document.getElementById('nc-search-input').value='';
  S.newGroupAvatarBase64 = null;
  const av = document.getElementById('new-group-av');
  if (av) { av.style.backgroundImage=''; av.textContent='G'; }
  openModal('modal-new-chat');
}

function renderModalUsers(containerId, multi, filter='') {
  const container = document.getElementById(containerId);
  if (!container) return;
  const list = S.allUsers.filter(u=>!filter||u.display_name.toLowerCase().includes(filter)||u.username.toLowerCase().includes(filter));
  container.innerHTML = list.map(u=>`
    <div class="user-row" data-uid="${u.id}" onclick="${multi?`toggleModalUser(this,${u.id})`:`startDirect(${u.id})`}">
      <div class="av av-sm av-round ${avatarColor(u.id)}" data-av-user="${u.id}">${initials(u.display_name)}</div>
      <div><div class="uname">${esc(u.display_name)}</div><div class="ulogin">@${esc(u.username)}</div></div>
    </div>`).join('') || '<div style="padding:12px;color:var(--muted);font-size:13px">Нет пользователей</div>';
  applyAvatars();
}

function filterModalUsers(q, containerId) {
  const multi = containerId==='tab-group';
  // Only filter the visible list
  const el = document.getElementById(containerId);
  if (el?.style.display==='none') return;
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
  const selected = [...document.querySelectorAll('#tab-group .user-row.selected')].map(el=>parseInt(el.dataset.uid));
  const data = await api('POST','/chats/group',{name, member_ids:selected});
  if (data?.id) {
    if (S.newGroupAvatarBase64) {
      await api('POST', `/chats/${data.id}/avatar`, { data: S.newGroupAvatarBase64 });
      S.newGroupAvatarBase64 = null;
    }
    closeModal('modal-new-chat'); await loadChats(); openChat(data.id);
  }
}

function switchTab(tab) {
  document.querySelectorAll('.nc-type-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`nc-btn-${tab}`).classList.add('active');
  document.getElementById('tab-direct').style.display = tab==='direct' ? 'flex' : 'none';
  document.getElementById('tab-group').style.display = tab==='group' ? 'flex' : 'none';
  document.getElementById('nc-group-settings').style.display = tab==='group' ? '' : 'none';
  document.getElementById('nc-footer').style.display = tab==='group' ? '' : 'none';
  document.getElementById('nc-title').textContent = tab==='direct' ? 'Новый чат' : 'Новая группа';
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
      <div class="av av-sm av-round ${avatarColor(m.id)}" data-av-user="${m.id}">${initials(m.display_name)}</div>
      <div class="info"><div class="rname">${esc(m.display_name)}</div><div class="rlogin">@${esc(m.username)}</div></div>
      <button class="rm-btn" onclick="egRemoveMember(${m.id})">✕</button>
    </div>`).join('') || '<div style="font-size:13px;color:var(--muted)">Только вы</div>';
  applyAvatars();
}

function renderEgAdd(existingMembers) {
  const existingIds = new Set(existingMembers.map(m=>m.id));
  const container = document.getElementById('eg-add');
  const available = S.allUsers.filter(u=>!existingIds.has(u.id)||S.egRemovedIds.has(u.id));
  container.innerHTML = available.map(u=>`
    <div class="user-row${S.egAddIds.has(u.id)?' selected':''}" data-uid="${u.id}" onclick="egToggleAdd(this,${u.id})">
      <div class="av av-sm av-round ${avatarColor(u.id)}" data-av-user="${u.id}">${initials(u.display_name)}</div>
      <div><div class="uname">${esc(u.display_name)}</div><div class="ulogin">@${esc(u.username)}</div></div>
    </div>`).join('') || '<div style="font-size:13px;color:var(--muted)">Нет доступных</div>';
  applyAvatars();
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

// ── CHAT LIST CONTEXT MENU ──
function showChatCtx(e, chatId) {
  e.preventDefault();
  e.stopPropagation();
  S.ctxChatId = chatId;
  const menu = document.getElementById('ctx-chat-menu');
  const chat = S.chats.find(c => c.id === chatId);
  const pinLabel = document.getElementById('ctx-chat-pin-label');
  if (pinLabel) pinLabel.textContent = chat?.pinned ? 'Открепить' : 'Закрепить';
  const pinBtn = document.getElementById('ctx-chat-pin');
  if (pinBtn) pinBtn.style.display = chat?.type === 'room' ? 'none' : '';
  menu.style.display = 'block';
  const x = Math.min(e.clientX, window.innerWidth - 160);
  const y = Math.min(e.clientY, window.innerHeight - 80);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

async function ctxChatPin() {
  document.getElementById('ctx-chat-menu').style.display = 'none';
  if (!S.ctxChatId) return;
  await api('POST', `/chats/${S.ctxChatId}/pin`);
  await loadChats();
}

async function ctxChatDelete() {
  document.getElementById('ctx-chat-menu').style.display = 'none';
  if (!S.ctxChatId) return;
  await deleteChat(S.ctxChatId);
}

// ── MODAL HELPERS ──
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) {
  const el = document.getElementById(id);
  if (!el || !el.classList.contains('open') || el.classList.contains('closing')) return;
  el.classList.add('closing');
  const onEnd = e => {
    if (e.target !== el) return;
    el.classList.remove('open', 'closing');
    el.removeEventListener('animationend', onEnd);
  };
  el.addEventListener('animationend', onEnd);
}

// ── SERVER UNAVAILABLE TOAST ──
function showServerToast() {
  let el = document.getElementById('server-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'server-toast';
    el.innerHTML = `<div class="server-toast-spinner"></div><span>Нет соединения с сервером. Переподключение…</span>`;
    document.body.appendChild(el);
  }
  el.classList.add('visible');
}

function hideServerToast() {
  document.getElementById('server-toast')?.classList.remove('visible');
}

// Короткий информационный тост (напр. отказ редактирования). Автоскрытие через 2.5с.
let _actionToastTimer = null;
function showActionToast(text) {
  let el = document.getElementById('action-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'action-toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('visible');
  clearTimeout(_actionToastTimer);
  _actionToastTimer = setTimeout(() => el.classList.remove('visible'), 2500);
}

// ── HIGH AVAILABILITY ──
async function openHAModal() {
  const select = document.getElementById('ha-drive-select');
  const activeInfo = document.getElementById('ha-active-info');
  const disableBtn = document.getElementById('ha-disable-btn');
  const pathPreview = document.getElementById('ha-path-preview');

  select.innerHTML = '<option value="">Загрузка…</option>';
  openModal('modal-ha');

  const [drives, cfg] = await Promise.all([
    window.electron.listDrives(),
    window.electron.getHAConfig(),
  ]);

  if (cfg?.drive) {
    activeInfo.style.display = 'block';
    document.getElementById('ha-active-path').textContent = `${cfg.drive}:\\Electron`;
    disableBtn.style.display = 'inline-flex';
  } else {
    activeInfo.style.display = 'none';
    disableBtn.style.display = 'none';
  }

  select.innerHTML = '<option value="">— Выберите диск —</option>' +
    drives.map(d => `<option value="${d.letter}" ${cfg?.drive === d.letter ? 'selected' : ''}>${d.label}</option>`).join('');

  const updatePreview = () => {
    const v = select.value;
    pathPreview.textContent = v ? `${v}:\\Electron` : '…\\Electron';
  };
  select.onchange = updatePreview;
  updatePreview();
}

async function saveHA() {
  const drive = document.getElementById('ha-drive-select').value;
  if (!drive) { return; }
  await window.electron.setHAConfig(drive);
  // app will relaunch automatically
}

async function disableHA() {
  closeModal('modal-ha');
  await window.electron.clearHAConfig();
  // app will relaunch automatically
}

// ── AUTO UPDATE ──
let _updateDownloadUrl = null;

function setUpdateBadge(visible) {
  const badge = document.getElementById('update-badge');
  if (badge) badge.style.display = visible ? '' : 'none';
}

function skipUpdate() {
  if (_updateDownloadUrl) {
    const ver = document.getElementById('update-new-version').textContent.replace(/^v/, '');
    localStorage.setItem('skippedVersion', ver);
    setUpdateBadge(false);
  }
  closeModal('modal-update');
}

// Проверка обновления без учёта «пропущенной» версии — используется при force_update от сервера
async function checkUpdateForced() {
  if (!window.electron?.checkUpdate) return;
  const result = await window.electron.checkUpdate();
  if (result.error || result.upToDate) return;
  _updateDownloadUrl = result.downloadUrl || null;
}

async function checkUpdate(silent = false) {
  if (!window.electron?.checkUpdate) return;
  const btn = document.getElementById('update-check-btn');
  const status = document.getElementById('update-status-text');
  if (!silent) {
    btn.disabled = true;
    btn.textContent = 'Проверяю…';
    status.textContent = 'Проверяю…';
  }

  const result = await window.electron.checkUpdate();

  if (!silent) {
    btn.disabled = false;
    btn.textContent = 'Проверить';
  }

  if (result.error) { if (!silent) status.textContent = 'Ошибка проверки'; return; }
  if (result.upToDate) { if (!silent) status.textContent = 'Версия актуальна'; setUpdateBadge(false); return; }

  const skipped = localStorage.getItem('skippedVersion');
  if (silent && skipped === result.version) return;

  _updateDownloadUrl = result.downloadUrl;
  setUpdateBadge(true);
  if (!silent) status.textContent = `Доступна v${result.version}`;

  try {
    document.getElementById('update-new-version').textContent = `v${result.version}`;
    document.getElementById('update-notes').textContent = result.notes || 'Нет описания';
    document.getElementById('update-progress-wrap').style.display = 'none';
    document.getElementById('update-install-btn').disabled = false;
    document.getElementById('update-install-btn').style.opacity = '';
  } catch {}

  window.electron?.onUpdateProgress?.(p => {
    document.getElementById('update-progress-wrap').style.display = '';
    document.getElementById('update-progress-fill').style.width = p + '%';
    document.getElementById('update-progress-text').textContent = `Загрузка ${p}%`;
  });

  closeSettings(); // закрываем настройки перед показом модалки обновления
  const modal = document.getElementById('modal-update');
  if (modal && !modal.classList.contains('open')) openModal('modal-update');
}

// Автопроверка обновлений раз в минуту
setTimeout(() => {
  checkUpdate(true);
  setInterval(() => checkUpdate(true), 2 * 60 * 60 * 1000);
}, 10 * 1000);

async function installUpdate() {
  if (!_updateDownloadUrl) return;
  const btn = document.getElementById('update-install-btn');
  const cancel = document.getElementById('update-cancel-btn');
  btn.disabled = true;
  btn.style.opacity = '0.6';
  cancel.textContent = 'Закрыть';
  document.getElementById('update-progress-wrap').style.display = '';
  document.getElementById('update-progress-text').textContent = 'Загрузка…';
  const result = await window.electron.installUpdate(_updateDownloadUrl);
  if (result?.error) {
    document.getElementById('update-progress-text').textContent = 'Ошибка: ' + result.error;
    btn.disabled = false;
    btn.style.opacity = '';
  }
}

async function forceInstallUpdate() {
  if (!_updateDownloadUrl) return;
  closeModal('modal-update');
  document.getElementById('force-update-fill').style.width = '0%';
  document.getElementById('force-update-pct').textContent = '0%';
  document.getElementById('force-update-sub').textContent = 'Загрузка обновления…';
  openModal('modal-force-update');
  window.electron.onUpdateProgress(p => {
    document.getElementById('force-update-fill').style.width = p + '%';
    document.getElementById('force-update-pct').textContent = p + '%';
    if (p >= 100) document.getElementById('force-update-sub').textContent = 'Установка…';
  });
  const result = await window.electron.installUpdate(_updateDownloadUrl);
  if (result?.error) {
    document.getElementById('force-update-sub').textContent = 'Ошибка: ' + result.error;
  }
}
