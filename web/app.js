'use strict';

// ── SERVICE WORKER REGISTRATION ──
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type === 'open-chat') {
        const chat = S.chats.find(c => c.id === e.data.chatId);
        if (chat) openChat(e.data.chatId);
      }
    });
  });
}

// ── STATE ──
const S = {
  server: '', token: null, user: null,
  chats: [], activeChatId: null,
  ws: null, wsRetry: 0,
  unread: {}, allUsers: [],
  settings: { theme: 'dark', fontSize: 'medium', chatView: 'irc' },
  ctx: { messageId: null, canEdit: false, isMine: false, replyText: '', replySenderName: '' },
  editingMessageId: null,
  replyTo: null,
  egChatId: null, egRemovedIds: new Set(), egAddIds: new Set(),
  newGroupAvatarBase64: null,
  presence: {},
  reactions: {},
  chatHasMore: false,
  chatOldestId: null,
};

const SESSION_KEY = 'electron_v2';
let _loadingMore = false;
const _avatarCache = new Map();
let _fetchController = new AbortController();

// ── UTILS ──
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

// ── PROTOCOL ──
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

// ── WEB NOTIFICATIONS ──
function webNotify(title, body, chatId) {
  if (Notification.permission !== 'granted') return;
  const n = new Notification(title, {
    body,
    icon: '/icons/icon.svg',
    badge: '/icons/icon.svg',
    tag: chatId ? `chat-${chatId}` : 'msg',
    renotify: true,
  });
  n.onclick = () => {
    window.focus();
    const chat = S.chats.find(c => c.id === chatId);
    if (chat) openChat(chatId);
    n.close();
  };
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    dismissNotifBanner();
    await subscribePush();
  } else if (perm === 'denied') {
    dismissNotifBanner();
  }
}

async function subscribePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const data = await fetch(`${httpProto()}://${S.server}/api/push/vapid-public-key`).then(r => r.json());
    if (!data?.key) return;
    const appServerKey = urlBase64ToUint8Array(data.key);

    // Если уже есть подписка — проверяем что ключ совпадает, иначе переподписываемся
    let existing = await reg.pushManager.getSubscription();
    if (existing) {
      const existingKey = existing.options?.applicationServerKey;
      const existingKeyB64 = existingKey
        ? btoa(String.fromCharCode(...new Uint8Array(existingKey)))
        : null;
      const newKeyB64 = btoa(String.fromCharCode(...appServerKey));
      if (existingKeyB64 !== newKeyB64) {
        await existing.unsubscribe();
        existing = null;
      }
    }

    const sub = existing || await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: appServerKey,
    });
    await api('POST', '/push/subscribe', {
      endpoint: sub.endpoint,
      keys: {
        p256dh: btoa(String.fromCharCode(...new Uint8Array(sub.getKey('p256dh')))),
        auth:   btoa(String.fromCharCode(...new Uint8Array(sub.getKey('auth')))),
      },
    });
  } catch(e) { console.warn('Push subscribe failed:', e); }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

function dismissNotifBanner() {
  const b = document.getElementById('notif-banner');
  if (b) b.style.display = 'none';
  localStorage.setItem('notifBannerDismissed', '1');
}

function maybeShowNotifBanner() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') return;
  if (Notification.permission === 'denied') return;
  if (localStorage.getItem('notifBannerDismissed')) return;
  const b = document.getElementById('notif-banner');
  if (b) b.style.display = 'flex';
}

// ── MOBILE NAVIGATION ──
function mobileBack() {
  const chatMain = document.getElementById('chat-main');
  const sidebar = document.querySelector('.sidebar');
  chatMain?.classList.remove('mobile-open');
  sidebar?.classList.remove('mobile-hidden');
  S.activeChatId = null;
}

function openMobileChat() {
  const chatMain = document.getElementById('chat-main');
  const sidebar = document.querySelector('.sidebar');
  chatMain?.classList.add('mobile-open');
  sidebar?.classList.add('mobile-hidden');
}

// ── INIT ──
window.addEventListener('DOMContentLoaded', async () => {
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

  document.getElementById('l-password').addEventListener('keydown', e => e.key==='Enter' && doLogin());
  document.getElementById('l-server').addEventListener('keydown', e => e.key==='Enter' && document.getElementById('l-username').focus());
  document.getElementById('l-username').addEventListener('keydown', e => e.key==='Enter' && document.getElementById('l-password').focus());

  document.addEventListener('click', e => {
    hideCtxMenu();
    document.getElementById('ctx-chat-menu').style.display = 'none';
    const picker = document.getElementById('emoji-picker');
    if (picker && !picker.contains(e.target) && !e.target.closest('.emoji-btn')) {
      picker.style.display = 'none';
    }
  });
  document.addEventListener('keydown', e => { if(e.key==='Escape'){ hideCtxMenu(); closeSettings(); }});

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      if (S.activeChatId && S.ws?.readyState===1) {
        S.ws.send(JSON.stringify({type:'read', chat_id: S.activeChatId}));
        S.unread[S.activeChatId] = 0;
        updateUnreadTotal();
      }
      if (S.ws?.readyState===1) S.ws.send(JSON.stringify({type:'set_status', status:'online'}));
      updateSidebarStatus('online');
    } else {
      if (S.ws?.readyState===1) S.ws.send(JSON.stringify({type:'set_status', status:'away'}));
      updateSidebarStatus('away');
    }
  });

  // Drag-and-drop
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

  // Paste image from clipboard
  document.addEventListener('paste', async e => {
    if (!S.activeChatId) return;
    const file = Array.from(e.clipboardData.items)
      .find(i => i.type.startsWith('image/'))?.getAsFile();
    if (file) { e.preventDefault(); await uploadImageFile(file); }
  });

  // Open chat from URL param (SW notification click)
  const urlParams = new URLSearchParams(location.search);
  const chatIdParam = urlParams.get('chatId');
  if (chatIdParam && session?.token) {
    // Wait for chats to load then open
    S._pendingOpenChatId = parseInt(chatIdParam);
  }
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
  // Reset mobile state
  document.getElementById('chat-main')?.classList.remove('mobile-open');
  document.querySelector('.sidebar')?.classList.remove('mobile-hidden');
}

// ── ENTER APP ──
function enterApp() {
  document.getElementById('screen-login').classList.remove('active');
  document.getElementById('screen-main').classList.add('active');
  updateMeAvatar();
  document.getElementById('me-name').textContent = S.user.display_name;
  loadChats().then(() => {
    if (S._pendingOpenChatId) {
      const c = S.chats.find(c => c.id === S._pendingOpenChatId);
      if (c) openChat(S._pendingOpenChatId);
      S._pendingOpenChatId = null;
    }
  });
  loadUsers();
  connectWS();
  loadPresence();
  // Show notification permission banner or re-subscribe if already granted
  if (Notification.permission === 'granted') {
    subscribePush();
  } else {
    setTimeout(maybeShowNotifBanner, 800);
  }
}

function updateMeAvatar() {
  const el = document.getElementById('me-av');
  const url = `${httpProto()}://${S.server}/api/users/${S.user.id}/avatar?t=${Date.now()}`;
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
  document.querySelectorAll('#chatview-seg button').forEach(b => b.classList.toggle('active', b.dataset.view===(S.settings.chatView||'bubbles')));
  const sunIcon = document.getElementById('theme-icon-sun');
  const moonIcon = document.getElementById('theme-icon-moon');
  if (sunIcon) sunIcon.style.display = isDark ? '' : 'none';
  if (moonIcon) moonIcon.style.display = isDark ? 'none' : '';
}
function setTheme(t) { S.settings.theme=t; applySettings(); saveSession(); }
function toggleTheme() { setTheme(S.settings.theme === 'dark' ? 'light' : 'dark'); }
function setFontSize(f) { S.settings.fontSize=f; applySettings(); saveSession(); }
function setChatView(v) { S.settings.chatView=v; applySettings(); saveSession(); if (S.activeChatId) openChat(S.activeChatId); }
function toggleChatView() {
  setChatView(S.settings.chatView === 'irc' ? 'bubbles' : 'irc');
  updateViewToggleIcon();
}
function updateViewToggleIcon() {
  const ircIcon = document.getElementById('header-irc-icon');
  const bubbleIcon = document.getElementById('header-bubble-icon');
  if (!ircIcon) return;
  const isIRC = (S.settings.chatView||'bubbles') === 'irc';
  ircIcon.style.display = isIRC ? 'none' : '';
  bubbleIcon.style.display = isIRC ? '' : 'none';
}
async function openSettings() {
  document.getElementById('modal-settings').classList.add('open');
  const dn = document.getElementById('settings-display-name');
  if (dn) { dn.value = S.user.display_name; dn.readOnly = true; dn.classList.remove('editing'); }
  const un = document.getElementById('settings-username');
  if (un) un.textContent = '@' + S.user.username;
  const btn = document.getElementById('settings-edit-btn');
  if (btn) btn.textContent = 'Изменить';
  updateSettingsAvatar();
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

function applyAvatars() {
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
  if (!filtered.length) { list.innerHTML='<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px">Нет чатов</div>'; return; }

  const pinned = filtered.filter(c => c.pinned || c.type === 'room');
  const rest = filtered.filter(c => !c.pinned && c.type !== 'room');

  let html = '';
  if (pinned.length) {
    html += `<div class="chat-list-section-label">Закреплённые</div>`;
    html += pinned.map(c => renderChatRow(c)).join('');
  }
  html += `<div class="chat-list-section-label" style="${pinned.length?'padding-top:12px':''}">Все чаты</div>`;
  html += rest.map(c => renderChatRow(c)).join('');
  list.innerHTML = html;
  applyAvatars();
}

function renderChatRow(c) {
  const name = chatName(c);
  const u = S.unread[c.id]||0;
  const lm = c.last_message;
  let preview = lm ? (lm.deleted ? 'Сообщение удалено' : (lm.text || (lm.attachment ? '🖼 Изображение' : ''))) : 'Нет сообщений';
  if (preview.length>40) preview = preview.slice(0,40)+'…';
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
        <span class="ci-preview ci-last" style="flex:1">${esc(preview)}</span>
        ${u>0?`<div class="unread-badge">${u}</div>`:''}
      </div>
    </div>
  </div>`;
}

function filterChats() { renderChatList(); }

// ── OPEN CHAT ──
async function openChat(chatId) {
  S.activeChatId = chatId;
  S.chatHasMore = false;
  S.chatOldestId = null;
  _loadingMore = false;
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

  const main = document.getElementById('chat-main');
  main.innerHTML = `
    <div class="chat-header">
      <button class="icon-btn mobile-back-btn" onclick="mobileBack()" title="Назад" style="flex-shrink:0">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <div class="av-wrap">
        <div class="av av-md ${chatAvatarClass(chat)}${chat.type==='direct'?' av-round':''}" data-av-chat="${chat.id}">${chatIcon(chat)}</div>
        ${peerDot}
      </div>
      <div class="chat-header-info" ${nameClickable}>
        <div class="ch-name">${esc(name)}</div>
        <div class="ch-sub">${sub}</div>
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
  updateViewToggleIcon();
  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) { sendBtn.style.background='transparent'; sendBtn.style.color='var(--muted)'; sendBtn.style.boxShadow='none'; }
  if (S.ws && !document.hidden) S.ws.send(JSON.stringify({type:'read', chat_id: chatId}));

  const msgsEl = document.getElementById('messages');
  if (msgsEl) {
    msgsEl.innerHTML = `<div class="skeleton-wrap">${[200,280,160,240,120].map((w,i) =>
      `<div class="skeleton-msg ${i%2===0?'theirs':'mine'}">
        <div class="skeleton-av"></div>
        <div class="skeleton-bubble" style="width:${w}px"></div>
      </div>`).join('')}</div>`;
  }
  const data = await api('GET', `/messages/chat/${chatId}?limit=50`);
  if (data && S.activeChatId === chatId) {
    S.chatHasMore = data.hasMore;
    S.chatOldestId = data.messages[0]?.id ?? null;
    renderMessages(data.messages);
    const msgsEl2 = document.getElementById('messages');
    if (msgsEl2) {
      msgsEl2.addEventListener('scroll', onMessagesScroll, { passive: true });
      // Touch swipe-right on messages = reply (web only)
      addSwipeReply(msgsEl2);
    }
  }
  document.getElementById('msg-input')?.focus();

  // Mobile: show chat panel
  openMobileChat();
}

// ── SWIPE TO REPLY (touch) ──
function addSwipeReply(container) {
  let startX = 0, startY = 0, swipeEl = null, dirLocked = false;
  container.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    swipeEl = e.target.closest('[data-msg-id]');
    dirLocked = false;
  }, { passive: true });
  container.addEventListener('touchmove', e => {
    if (!swipeEl) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    // Определяем направление по первым 10px движения
    if (!dirLocked) {
      if (Math.abs(dy) > Math.abs(dx) || Math.abs(dx) < 6) return;
      dirLocked = true;
    }
    if (dx <= 0) { // только свайп вправо
      if (swipeEl) { swipeEl.style.transform = ''; swipeEl.style.transition = 'transform .2s'; }
      swipeEl = null; return;
    }
    e.preventDefault();
    const shift = Math.min(dx * 0.45, 50);
    swipeEl.style.transform = `translateX(${shift}px)`;
    swipeEl.style.transition = 'none';
  }, { passive: false });
  container.addEventListener('touchend', e => {
    if (!swipeEl) return;
    const dx = e.changedTouches[0].clientX - startX;
    swipeEl.style.transform = '';
    swipeEl.style.transition = 'transform .25s ease';
    if (dx > 50) {
      const msgId = parseInt(swipeEl.dataset.msgId);
      S.ctx.messageId = msgId;
      ctxReply();
    }
    swipeEl = null;
  }, { passive: true });
}

// ── LONG PRESS → CONTEXT MENU (touch) ──
let _longPressTimer = null;
document.addEventListener('touchstart', e => {
  const msgEl = e.target.closest('[data-msg-id]');
  if (!msgEl) return;
  _longPressTimer = setTimeout(() => {
    const msgId = parseInt(msgEl.dataset.msgId);
    const sentAt = parseInt(msgEl.dataset.sentAt || '0');
    const isMine = parseInt(msgEl.dataset.senderId) === S.user?.id;
    // Simulate context menu at touch position
    const touch = e.touches[0];
    showCtxMenu({ clientX: touch.clientX, clientY: touch.clientY, preventDefault: ()=>{} }, msgId, sentAt, isMine);
  }, 600);
}, { passive: true });
document.addEventListener('touchend', () => { clearTimeout(_longPressTimer); _longPressTimer = null; }, { passive: true });
document.addEventListener('touchmove', () => { clearTimeout(_longPressTimer); _longPressTimer = null; }, { passive: true });

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
function sameTimeGroup(a, b) {
  if (!a || !b) return false;
  if (a.sender_id !== b.sender_id) return false;
  const ta = new Date(a.sent_at * 1000), tb = new Date(b.sent_at * 1000);
  return ta.getHours() === tb.getHours() && ta.getMinutes() === tb.getMinutes() && ta.toDateString() === tb.toDateString();
}

function renderMessages(msgs) {
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
      lastSenderId = null;
    }
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
  container.scrollTop = container.scrollHeight;
}

function onMessagesScroll() {
  const container = document.getElementById('messages');
  if (!container || !S.chatHasMore || _loadingMore) return;
  if (container.scrollTop < 80) loadMoreMessages();
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
  if ((S.settings.chatView||'bubbles') === 'irc') return renderMsgIRC(m, grouped);
  const mine = m.sender_id===S.user.id;
  const time = fmtTime(m.sent_at);
  const isDeleted = m.deleted;
  const bodyText = isDeleted ? 'Сообщение удалено' : linkifyText(m.text) + (m.edited_at?` <span class="edited-tag">изм.</span>`:'');
  const statusIcon = mine && !isDeleted ? renderStatus(m.status) : '';
  const reactionsHtml = isDeleted ? '' : renderReactions(m.id);
  const replyHtml = m.reply_to_id ? `
    <div class="reply-quote" onclick="scrollToMsg(${m.reply_to_id})">
      <div class="reply-quote-name">${esc(m.reply_sender_name || '')}</div>
      <div class="reply-quote-text">${m.reply_deleted ? 'Сообщение удалено' : esc((m.reply_text||'').slice(0,80))}</div>
    </div>` : '';
  const att = m.attachment;
  const attachHtml = (!isDeleted && att?.url) ? `<div class="bubble-image" onclick="openLightbox('${httpProto()}://${S.server}${att.url}')"><img src="${httpProto()}://${S.server}${att.url}" loading="lazy"></div>` : '';
  const avColor = avatarColor(m.sender_id);
  const avLetter = initials(m.sender_name||'').slice(0,1);
  const avImg = `<img src="${httpProto()}://${S.server}/api/users/${m.sender_id}/avatar" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:50%" onerror="this.style.display='none'">`;
  const avatarHtml = isChatGroup
    ? ((!mine && isLast)
        ? `<div class="av av-sm av-round ${avColor}" style="position:relative;flex-shrink:0;align-self:flex-end;margin-bottom:2px">${avLetter}${avImg}</div>`
        : (!mine ? `<div style="width:32px;flex-shrink:0"></div>` : ''))
    : '';
  const colorKey = avColor.replace('av-', '');
  const tagHtml = (!mine && isChatGroup && m.sender_tag) ? `<span class="bubble-tag bubble-tag-${colorKey}">${esc(m.sender_tag)}</span>` : '';
  const senderNameHtml = (!mine && !grouped && isChatGroup)
    ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:3px"><span class="bubble-sender bubble-sender-${colorKey}">${esc(m.sender_name)}</span>${tagHtml}</div>`
    : (tagHtml && !grouped ? `<div style="display:flex;justify-content:flex-end;margin-bottom:3px">${tagHtml}</div>` : '');
  const bubblePositionClass = !grouped && isLast ? '' : (!grouped ? ' bubble-first' : (isLast ? ' bubble-last' : ' bubble-mid'));
  return `<div class="msg-group ${mine?'mine':'theirs'}${grouped?' grouped':''}${m._optimistic?' msg-optimistic':''}" data-msg-id="${m.id}" data-sender-id="${m.sender_id}" data-sent-at="${m.sent_at}"${m._optimistic?' data-optimistic="1"':''}>
    <div class="msg-bubble-row">
      ${avatarHtml}
      <div class="msg-row">
        <div class="bubble${isDeleted?' deleted':''}${bubblePositionClass}" oncontextmenu="${!isDeleted?`showCtxMenu(event,${m.id},${m.sent_at},${mine})`:'event.preventDefault()'}" ondblclick="${!isDeleted?`dblReply(${m.id})`:''}">
          ${senderNameHtml}
          ${replyHtml}
          ${attachHtml}
          ${m.text ? `<div class="bubble-text">${bodyText}</div>` : (isDeleted ? `<div class="bubble-text">${bodyText}</div>` : '')}
          <div class="bubble-meta">${time}<span class="status-wrap">${statusIcon}</span></div>
        </div>
      </div>
    </div>
    ${reactionsHtml}
  </div>`;
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
  const attachHtml = (!isDeleted && att?.url) ? `<div class="bubble-image" style="margin:4px 0;max-width:260px" onclick="openLightbox('${httpProto()}://${S.server}${att.url}')"><img src="${httpProto()}://${S.server}${att.url}" loading="lazy"></div>` : '';

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
  if (read > 0)           { cls = 'status-read';       title = 'Прочитано'; }
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
    }
  }
  const isChatGroupAppend = chat?.type==='group' || chat?.type==='room';
  container.insertAdjacentHTML('beforeend', renderMsg(m, isChatGroupAppend, false, grouped, true));
  const newEl = container.lastElementChild;
  if (newEl && !m._optimistic) newEl.classList.add('msg-new');

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

const typingTimers = {};
let typingSendTimer = null;

function onMsgInput(el) {
  autoResize(el);
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
  const item = document.querySelector(`.chat-item[data-chat-id="${chatId}"] .ci-last`);
  if (item) { item.dataset.origText = item.dataset.origText || item.textContent; item.textContent = `${senderName} печатает…`; item.classList.add('typing-preview'); }
  typingTimers[chatId] = setTimeout(() => { clearTyping(chatId); }, 5000);
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
  el.style.height = '20px';
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
  appendMsg(tempMsg);

  S.ws.send(JSON.stringify(payload));
  hideReplyBar();
  clearImagePreview();
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
  e.preventDefault(); e.stopPropagation?.();
  S.ctx.messageId = msgId;
  S.ctx.canEdit = isMine && (Date.now()/1000 - sentAt) < 120;
  S.ctx.isMine = isMine;
  const menu = document.getElementById('ctx-menu');
  document.getElementById('ctx-reply-btn').style.display = '';
  document.getElementById('ctx-copy-btn').style.display = '';
  document.getElementById('ctx-edit-btn').style.display = (isMine && S.ctx.canEdit) ? '' : 'none';
  document.getElementById('ctx-delete-btn').style.display = isMine ? '' : 'none';
  document.getElementById('ctx-info-btn').style.display = isMine ? '' : 'none';
  menu.style.top = '-9999px'; menu.style.left = '-9999px';
  menu.classList.add('open');
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const margin = 6;
  let x = e.clientX, y = e.clientY;
  if (x + mw + margin > window.innerWidth)  x = window.innerWidth  - mw - margin;
  if (y + mh + margin > window.innerHeight) y = e.clientY - mh;
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
  const el = document.querySelector(`[data-msg-id="${msgId}"] .bubble-text`);
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
  if (!el) return;
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
      body += readUsers.map(s => `<div class="msg-info-user-row"><div style="font-size:13px;font-weight:500">${esc(s.display_name)}</div><div style="font-size:12px;color:var(--muted)">${fmtDt(s.read_at)}</div></div>`).join('');
    }
    if (unreadUsers.length) {
      body += `<div class="msg-info-label" style="padding:${readUsers.length?'8px':'0'} 2px 0">Не прочитали</div>`;
      body += unreadUsers.map(s => `<div class="msg-info-user-row"><div style="font-size:13px;color:var(--muted)">${esc(s.display_name)}</div></div>`).join('');
    }
    if (!data.statuses.length) {
      body += `<div style="text-align:center;padding:16px;color:var(--muted);font-size:13px">Никто ещё не прочитал</div>`;
    }
  }
  document.getElementById('msg-info-body').innerHTML = body;
  openModal('modal-msg-info');
}

// ── CUSTOM CONFIRM ──
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

// ── DELETE CHAT ──
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
    document.getElementById('chat-main').classList.remove('mobile-open');
    document.querySelector('.sidebar')?.classList.remove('mobile-hidden');
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
  document.getElementById('chat-main').classList.remove('mobile-open');
  document.querySelector('.sidebar')?.classList.remove('mobile-hidden');
  loadChats();
}

// ── WEBSOCKET ──
function connectWS() {
  const ws = new WebSocket(`${wsProto()}://${S.server}/ws?token=${S.token}`);
  S.ws = ws;

  ws.onmessage = async e => {
    let data; try { data=JSON.parse(e.data); } catch { return; }

    if (data.type==='message') {
      const { message } = data;
      const chatId = message.chat_id;
      const chat = S.chats.find(c=>c.id===chatId);
      if (chat) chat.last_message = message;
      if (S.activeChatId===chatId) {
        if (message.sender_id === S.user.id) {
          document.querySelector('[data-optimistic="1"]')?.remove();
        }
        appendMsg(message);
        if (!document.hidden && S.ws?.readyState===1) {
          S.ws.send(JSON.stringify({type:'read', chat_id:chatId}));
          S.ws.send(JSON.stringify({type:'delivered', message_id:message.id}));
        } else if (document.hidden && message.sender_id !== S.user.id) {
          S.unread[chatId] = (S.unread[chatId]||0)+1;
          const title = chatName(chat) || 'Electron';
          const body = `${message.sender_name}: ${message.text || (message.attachment ? '🖼 Изображение' : '')}`;
          webNotify(title, body, chatId);
          playNotificationSound();
          if (S.ws?.readyState===1) S.ws.send(JSON.stringify({type:'delivered', message_id:message.id}));
        }
      } else {
        S.unread[chatId] = (S.unread[chatId]||0)+1;
        if (message.sender_id!==S.user.id) {
          const chat2 = S.chats.find(c=>c.id===chatId);
          const title = chatName(chat2) || 'Electron';
          const body = `${message.sender_name}: ${message.text || (message.attachment ? '🖼 Изображение' : '')}`;
          webNotify(title, body, chatId);
          playNotificationSound();
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

    if (data.type==='reload_chats') { loadChats(); }
    if (data.type==='chat_deleted') { removeChatLocally(data.chat_id); }

    if (data.type==='chat_cleared') {
      const chat = S.chats.find(c => c.id === data.chat_id);
      if (chat) { chat.last_message = null; renderChatList(); }
      if (S.activeChatId === data.chat_id) {
        S.chatHasMore = false; S.chatOldestId = null;
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
          const isAtBottom = container && (container.scrollHeight - container.scrollTop - container.clientHeight < 10);
          const prevScrollHeight = container?.scrollHeight || 0;
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
            if (isAtBottom) container.scrollTop = container.scrollHeight;
            else if (delta > 0) container.scrollTop += delta;
          }
        }
      }
    }

    if (data.type==='typing') { showTyping(data.chat_id, data.sender_name); }

    if (data.type==='presence') {
      S.presence[data.user_id] = data.status;
      const color = data.status==='online'?'#22c55e':data.status==='away'?'#eab308':'#ef4444';
      document.querySelectorAll(`.presence-dot[data-user-id="${data.user_id}"]`).forEach(dot => {
        dot.style.background = color; dot.title = data.status;
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

    if (data.type==='avatar_updated') {
      S.avatarTs = Date.now();
      _avatarCache.clear();
      updateMeAvatar();
      renderChatList();
    }

    if (data.type === 'force_logout') { logout(); }
  };

  ws.onclose = () => {
    S.wsRetry++;
    const delay = Math.min(1000*S.wsRetry, 10000);
    if (S.token) {
      showServerToast();
      setTimeout(connectWS, delay);
    }
  };
  ws.onopen = () => {
    S.wsRetry = 0;
    hideServerToast();
    loadChats();
    setTimeout(() => {
      const initStatus = document.hidden ? 'away' : 'online';
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'set_status', status: initStatus }));
        const isPwa = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
        ws.send(JSON.stringify({
          type: 'client_info',
          hostname: isPwa ? 'PWA' : 'Web',
          clientVersion: 'web',
          osPlatform: navigator.platform || 'web',
          osRelease: navigator.userAgent.match(/iPhone|iPad|iPod/i) ? 'iOS'
            : navigator.userAgent.match(/Android/i) ? 'Android'
            : navigator.userAgent.match(/Mac/i) ? 'macOS'
            : 'Web',
          installScope: isPwa ? 'pwa' : 'web',
        }));
      }
      updateSidebarStatus(initStatus);
    }, 300);
  };
  ws.onerror = () => ws.close();
}

function updateUnreadTotal() {
  const total = Object.values(S.unread).reduce((a,b)=>a+b,0);
  document.title = total > 0 ? `(${total}) Electron` : 'Electron';
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
  menu.style.display = 'block';
  const x = Math.min(e.clientX, window.innerWidth - 160);
  const y = Math.min(e.clientY, window.innerHeight - 80);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
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

// ── SERVER TOAST ──
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
