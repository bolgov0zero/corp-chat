'use strict';

// ── SERVICE WORKER REGISTRATION ──
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/chat/sw.js', { scope: '/chat/' }).catch(() => {});
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
  unread: {}, unreadMentions: {}, allUsers: [], drafts: (()=>{ try { return JSON.parse(localStorage.getItem('chat_drafts'))||{}; } catch { return {}; } })(),
  settings: { theme: 'dark', fontSize: 'medium', uiScale: 100 },
  ctx: { messageId: null, canEdit: false, isMine: false, replyText: '', replySenderName: '' },
  editingMessageId: null,
  replyTo: null,
  giChatId: null, giRemovedIds: new Set(), giAddIds: new Set(), giAvatarBase64: null,
  newGroupAvatarBase64: null,
  presence: {},
  lastSeen: {}, // userId -> unix ts последнего онлайна
  reactions: {},
  msgStatus: {},      // messageId -> {delivered, read, total} для событий status_range
  statusApplied: {},  // messageId -> Set<'read:userId'|'delivered:userId'> для дедупликации
  chatHasMore: false,
  chatOldestId: null,
  chatHasMoreAfter: false,
  chatNewestId: null,
  searchResults: null,
};

const SESSION_KEY = 'electron_v2';
let _loadingMore = false;
const _avatarCache = new Map();
let _fetchController = new AbortController();

// ── UTILS ──
function saveDrafts() { try { localStorage.setItem('chat_drafts', JSON.stringify(S.drafts)); } catch {} }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// Markdown-lite: **жирный**, __курсив__, `код` — применяется к уже экранированному тексту
function mdLite(escaped) {
  return escaped
    .replace(/`([^`\n]+)`/g, '<code class="md-code">$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<i>$1</i>');
}

function linkifyText(text) {
  const urlRe = /(https?:\/\/[^\s]+)/g;
  return text.split(urlRe).map((part, i) => {
    if (i % 2 !== 1) return mdLite(esc(part).replace(/@([\w.-]+)/g, '<span class="mention">@$1</span>'));
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
const _CHAT_EASE = 'transform .32s cubic-bezier(.32,.72,0,1)';

function mobileBack(animated) {
  const cm = document.getElementById('chat-main');
  const sb = document.querySelector('.sidebar');
  S.activeChatId = null;

  if (animated === false) {
    cm?.classList.remove('mobile-open');
    if (cm) { cm.style.transform = ''; cm.style.transition = ''; }
    return;
  }

  if (cm) { cm.style.transition = _CHAT_EASE; cm.style.transform = 'translateX(100%)'; }
  sb?.classList.remove('mobile-hidden');

  const done = () => {
    cm?.classList.remove('mobile-open');
    if (cm) { cm.style.transform = ''; cm.style.transition = ''; }
  };
  if (cm) cm.addEventListener('transitionend', done, { once: true });
  else done();
}

const _isMobile = () => window.matchMedia('(max-width: 767px), (pointer: coarse)').matches;

function openMobileChat() {
  const cm = document.getElementById('chat-main');
  const sb = document.querySelector('.sidebar');
  if (!cm) return;

  cm.classList.add('mobile-open');
  sb?.classList.add('mobile-hidden');
  if (!_isMobile()) return;

  cm.style.transition = 'none';
  cm.style.transform = 'translateX(100%)';

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      cm.style.transition = _CHAT_EASE;
      cm.style.transform = '';
      cm.addEventListener('transitionend', () => {
        cm.style.transition = ''; cm.style.transform = '';
      }, { once: true });
    });
  });
}

// ── VIEWPORT / KEYBOARD (нативное поведение на мобильных) ──
// Высота всего экрана = высоте visual viewport. Клавиатура уменьшает
// viewport → CSS-флексбокс сам сжимает список сообщений, поле ввода
// остаётся над клавиатурой. Никакого ручного позиционирования.
let _maxVH = window.visualViewport ? window.visualViewport.height : window.innerHeight;
let _stickBottom = true; // был ли пользователь у нижнего края списка

function updateAppHeight() {
  const vv = window.visualViewport;
  const h = Math.round(vv ? vv.height : window.innerHeight);
  _maxVH = Math.max(_maxVH, h);
  const kbOpen = (_maxVH - h) > 80;
  const root = document.documentElement.style;
  // Экран растянут через inset (top+bottom), без фикс. высоты — низ всегда у края.
  // Клавиатура поднимает нижнюю границу на свою высоту (+небольшой запас, чтобы
  // поле гарантированно не перекрывалось краем клавиатуры).
  const kbHeight = kbOpen ? (_maxVH - h + 5) : 0;
  root.setProperty('--kb-height', kbHeight + 'px');
  // iOS сдвигает весь WebView вверх при фокусе на нижнем поле — компенсируем,
  // чтобы шапка стояла на месте, а двигалось только поле ввода/сообщения
  root.setProperty('--app-top', (vv ? vv.offsetTop : 0) + 'px');
  // Когда клавиатура открыта — home indicator скрыт, safe-area снизу не нужен
  root.setProperty('--input-safe-bottom', kbOpen ? '0px' : 'env(safe-area-inset-bottom, 0px)');
  // iOS иногда прокручивает всю страницу при фокусе — возвращаем на место
  if (window.scrollY !== 0) window.scrollTo(0, 0);
  // Держим список у нижнего края, если пользователь был внизу
  if (_stickBottom) pinMessagesToBottom();
}

function pinMessagesToBottom() {
  const msgs = document.getElementById('messages');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
}

// Совместимость со старым вызовом из openChat
function syncInputBarHeight() { updateAppHeight(); }

// «Пользователь реально смотрит в чат»: вкладка видима И окно в фокусе.
// На сенсорных устройствах фокус окна ненадёжен (клавиатура шлёт blur) —
// там достаточно видимости вкладки.
const _hasHover = window.matchMedia('(hover: hover)').matches;
function isViewing() {
  if (document.hidden) return false;
  if (_hasHover && typeof document.hasFocus === 'function') return document.hasFocus();
  return true;
}

// Единая реакция на смену активности (видимость/фокус): синхронизация, прочтение, статус.
function refreshActivity() {
  const viewing = isViewing();
  if (viewing) {
    // Соединение в фоне могло «умереть»: мёртвое — реконнект (onopen подтянет loadChats),
    // живое — досинхронизируем список на случай пропущенных сообщений.
    if (S.token) {
      if (!S.ws || S.ws.readyState >= 2) connectWS();
      else loadChats();
    }
    if (S.activeChatId && S.ws?.readyState===1) {
      S.ws.send(JSON.stringify({type:'read', chat_id: S.activeChatId}));
      S.unread[S.activeChatId] = 0;
      S.unreadMentions[S.activeChatId] = 0;
      updateUnreadTotal();
      renderChatList();
    }
  }
  if (S.ws?.readyState===1) S.ws.send(JSON.stringify({type:'set_status', status: viewing ? 'online' : 'offline'}));
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', updateAppHeight);
  window.visualViewport.addEventListener('scroll', updateAppHeight);
}
window.addEventListener('resize', updateAppHeight);
updateAppHeight();

document.addEventListener('focusin', e => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') {
    // При появлении клавиатуры держим список внизу
    _stickBottom = true;
    setTimeout(updateAppHeight, 50);
    setTimeout(() => { updateAppHeight(); pinMessagesToBottom(); }, 350);
  }
});
document.addEventListener('focusout', () => setTimeout(updateAppHeight, 100));

// ── INIT ──
window.addEventListener('DOMContentLoaded', async () => {
  S.server = window.location.host;
  const session = loadSession();
  if (session?.token) {
    Object.assign(S, { server: S.server, token:session.token, user:session.user, settings:session.settings||S.settings });
    applySettings();
    const ok = await Promise.race([
      api('GET', '/users/presence'),
      new Promise(r => setTimeout(() => r(null), 5000)),
    ]);
    if (S.token && ok !== null) enterApp();
  } else {
    applySettings();
  }

  document.getElementById('l-password').addEventListener('keydown', e => e.key==='Enter' && doLogin());
  document.getElementById('l-username').addEventListener('keydown', e => e.key==='Enter' && document.getElementById('l-password').focus());

  document.addEventListener('click', e => {
    hideCtxMenu();
    document.getElementById('ctx-chat-menu').style.display = 'none';
    if (!e.target.closest('#mention-popup')) hideMentionPopup();
    if (!e.target.closest('.composer-pill')) closeEmojiPicker();
  });
  document.addEventListener('keydown', e => { if(e.key==='Escape'){ hideCtxMenu(); closeSettings(); }});

  document.addEventListener('visibilitychange', refreshActivity);
  // На десктопе окно может быть видимым, но не в фокусе (за другим окном) — тогда
  // пользователь не смотрит в чат. На сенсорных устройствах окно либо на переднем
  // плане, либо скрыто, а blur прилетает при открытии клавиатуры — поэтому там не вешаем.
  if (_hasHover) {
    window.addEventListener('focus', refreshActivity);
    window.addEventListener('blur', refreshActivity);
  }

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
    const file = e.dataTransfer.files[0];
    if (file) await uploadFile(file);
  });

  // Paste image from clipboard
  document.addEventListener('paste', async e => {
    if (!S.activeChatId) return;
    const file = Array.from(e.clipboardData.items)
      .find(i => i.kind === 'file')?.getAsFile();
    if (file) { e.preventDefault(); await uploadFile(file); }
  });

  // Open chat from URL param (SW notification click)
  const urlParams = new URLSearchParams(location.search);
  const chatIdParam = urlParams.get('chatId');
  if (chatIdParam && session?.token) {
    S._pendingOpenChatId = parseInt(chatIdParam);
    // Убираем параметр из URL чтобы при следующем открытии PWA чат не открывался автоматически
    history.replaceState(null, '', location.pathname);
  }
});

// ── LOGIN ──
async function doLogin() {
  const username = document.getElementById('l-username').value.trim();
  const password = document.getElementById('l-password').value;
  const err = document.getElementById('l-err');
  const btn = document.getElementById('l-btn');
  if (!username||!password) { err.textContent='Заполните все поля'; return; }
  btn.disabled=true; btn.textContent='Подключение...'; err.textContent='';
  try {
    const res = await fetch(`${httpProto()}://${S.server}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
    const data = await res.json();
    if (data.token) {
      Object.assign(S, { token:data.token, user:data.user });
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
  loadChats().then(() => {
    if (S._pendingOpenChatId) {
      const c = S.chats.find(c => c.id === S._pendingOpenChatId);
      if (c) openChat(S._pendingOpenChatId);
      S._pendingOpenChatId = null;
    }
  });
  loadUsers();
  loadUploadSettings();
  connectWS();
  loadPresence();
  // Show notification permission banner or re-subscribe if already granted
  if (Notification.permission === 'granted') {
    subscribePush();
  } else {
    setTimeout(maybeShowNotifBanner, 800);
  }
  // Sidebar account bar
  const acAv = document.getElementById('sb-account-av');
  const acName = document.getElementById('sb-account-name');
  if (acAv && S.user) {
    acAv.className = `av sa-av ${avatarColor(S.user.id)}`;
    acAv.style.backgroundImage = '';
    acAv.textContent = initials(S.user.display_name);
    const acUrl = `${httpProto()}://${S.server}/api/users/${S.user.id}/avatar?t=${Date.now()}`;
    tryLoadAvatar(acAv, acUrl, initials(S.user.display_name));
  }
  if (acName && S.user) acName.textContent = S.user.display_name;
}


function updateSidebarThemeIcon() {
  const isDark = S.settings.theme === 'dark';
  ['sidebar-theme-sun', 'sb-theme-sun'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isDark ? '' : 'none';
  });
  ['sidebar-theme-moon', 'sb-theme-moon'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isDark ? 'none' : '';
  });
}


// ── SETTINGS ──
function applySettings() {
  const isDark = S.settings.theme === 'dark';
  document.documentElement.classList.toggle('dark', isDark);
  document.documentElement.className = document.documentElement.className.replace(/font-\w+/,'');
  document.documentElement.classList.add('font-'+S.settings.fontSize);
  document.querySelectorAll('#theme-seg button').forEach(b => b.classList.toggle('active', b.textContent.trim()===(S.settings.theme==='light'?'Светлая':'Тёмная')));
  document.querySelectorAll('#font-seg button').forEach(b => b.classList.toggle('active', b.textContent.trim()===S.settings.fontSize[0].toUpperCase()));
  const _scale = S.settings.uiScale || 100;
  document.documentElement.style.zoom = _scale !== 100 ? _scale + '%' : '';
  document.documentElement.style.minHeight = '';
  document.body.style.height = '';
  document.documentElement.style.setProperty('--vh100', _scale !== 100 ? `calc(100dvh / ${_scale / 100})` : '100dvh');
  document.querySelectorAll('#scale-seg button').forEach(b => b.classList.toggle('active', parseInt(b.textContent) === _scale));
  updateAppHeight();
  updateSidebarThemeIcon();
  // Цвет системного UI (статус-бар, клавиатура) следует теме
  document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta) themeColorMeta.content = isDark ? '#0b0d14' : '#f7f7fb';
}
function setTheme(t) { S.settings.theme=t; applySettings(); saveSession(); }
function toggleTheme() { setTheme(S.settings.theme === 'dark' ? 'light' : 'dark'); }
function setFontSize(f) { S.settings.fontSize=f; applySettings(); saveSession(); }
function setUiScale(v) { S.settings.uiScale=v; applySettings(); saveSession(); }
async function openSettings() {
  openModal('modal-settings');
  showSettingsTab('profile');
}

function showSettingsTab(tab) {
  document.querySelectorAll('.settings-nav-item').forEach(el => {
    el.classList.toggle('active', el.id === 'snav-' + tab);
  });
  const content = document.getElementById('settings-content');
  if (!content) return;

  if (tab === 'profile') {
    const u = S.user;
    const avColor = avatarColor(u.id);
    content.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;gap:10px;margin-bottom:24px">
        <div style="position:relative">
          <div class="av" id="settings-av" style="width:72px;height:72px;font-size:22px;font-weight:700;cursor:pointer" onclick="triggerAvatarUpload()"></div>
          <div style="position:absolute;bottom:-4px;right:-4px;width:24px;height:24px;border-radius:7px;background:var(--role-indigo);border:2px solid var(--modal-bg);display:flex;align-items:center;justify-content:center;cursor:pointer" onclick="triggerAvatarUpload()">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          </div>
        </div>
        <div style="font-size:13px;color:var(--text2)">@${esc(u.username)}</div>
      </div>
      <input type="file" id="avatar-file-input" accept="image/*" style="display:none" onchange="onAvatarFileChange(this)">
      <div style="margin-bottom:24px">
        <div style="font-size:11px;color:var(--muted);margin-bottom:6px">Имя пользователя</div>
        <div style="display:flex;gap:8px">
          <input id="settings-display-name" class="settings-name-input" value="${esc(u.display_name)}" style="flex:1;background:var(--search-bg);border:1px solid var(--border);border-radius:9px;padding:9px 12px;font-size:13px;font-weight:600;color:var(--text);font-family:inherit;outline:none;pointer-events:auto;border-color:transparent" onfocus="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor='transparent'">
          <button onclick="saveDisplayName()" class="settings-save-btn">Сохранить</button>
        </div>
      </div>
      <button class="setting-logout" onclick="logout()">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        Выйти из аккаунта
      </button>`;
    const avEl = document.getElementById('settings-av');
    if (avEl) {
      avEl.className = `av ${avColor}`;
      avEl.textContent = initials(u.display_name);
      updateSettingsAvatar();
    }

  } else if (tab === 'general') {
    content.innerHTML = `
      <div style="font-size:11px;letter-spacing:1px;color:var(--muted);text-transform:uppercase;font-weight:700;margin-bottom:10px">Система</div>
      <div class="setting-row" style="border:none">
        <span>Звук сообщений</span>
        <label class="toggle"><input type="checkbox" id="sound-chk" onchange="S.settings.soundEnabled=this.checked;saveSession()" ${S.settings.soundEnabled!==false?'checked':''}><span class="toggle-slider"></span></label>
      </div>
      <div style="font-size:11px;letter-spacing:1px;color:var(--muted);text-transform:uppercase;font-weight:700;margin-bottom:10px;margin-top:16px">Внешний вид</div>
      <div class="setting-row" style="border:none">
        <span>Тема</span>
        <div class="seg" id="theme-seg">
          <button onclick="setTheme('light')">Светлая</button>
          <button onclick="setTheme('dark')">Тёмная</button>
        </div>
      </div>
      <div class="setting-row">
        <span>Размер текста</span>
        <div class="seg" id="font-seg">
          <button onclick="setFontSize('small')">S</button>
          <button onclick="setFontSize('medium')">M</button>
          <button onclick="setFontSize('large')">L</button>
        </div>
      </div>
      <div class="setting-row" style="border:none">
        <span>Масштаб интерфейса</span>
        <div class="seg" id="scale-seg">
          <button onclick="setUiScale(80)">80%</button>
          <button onclick="setUiScale(90)">90%</button>
          <button onclick="setUiScale(100)">100%</button>
        </div>
      </div>`;
    applySettings();

  }
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
  chats.forEach(c => {
    S.unread[c.id] = (c.id === S.activeChatId) ? 0 : (c.unread || 0);
    S.unreadMentions[c.id] = (c.id === S.activeChatId) ? 0 : (c.unread_mentions || 0);
  });
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

const _chatRowCache = new Map(); // key -> html последней отрисовки
function syncChatListKeyed(list, items) {
  const seen = new Set();
  let prev = null;
  items.forEach(it => {
    seen.add(it.key);
    let el = list.querySelector(`[data-key="${CSS.escape(it.key)}"]`);
    if (el && _chatRowCache.get(it.key) !== it.html) {
      const tmp = document.createElement('div');
      tmp.innerHTML = it.html;
      const fresh = tmp.firstElementChild;
      fresh.dataset.key = it.key;
      el.replaceWith(fresh);
      el = fresh;
    } else if (!el) {
      const tmp = document.createElement('div');
      tmp.innerHTML = it.html;
      el = tmp.firstElementChild;
      el.dataset.key = it.key;
      list.appendChild(el);
    }
    _chatRowCache.set(it.key, it.html);
    // Порядок: элемент должен стоять сразу после предыдущего
    if (prev) {
      if (prev.nextElementSibling !== el) list.insertBefore(el, prev.nextElementSibling);
    } else if (list.firstElementChild !== el) {
      list.insertBefore(el, list.firstElementChild);
    }
    prev = el;
  });
  // Удаляем строки, которых больше нет
  [...list.children].forEach(ch => {
    if (!ch.dataset.key || !seen.has(ch.dataset.key)) {
      if (ch.dataset.key) _chatRowCache.delete(ch.dataset.key);
      ch.remove();
    }
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
      // Комнаты — статичный порядок по имени, не двигаются от новых сообщений
      if (a.type==='room' && b.type==='room') return chatName(a).localeCompare(chatName(b), 'ru');
      const ta = a.last_message?.sent_at||0, tb = b.last_message?.sent_at||0;
      return tb-ta;
    });
  const pinned = filtered.filter(c => c.pinned || c.type === 'room');
  const rest = filtered.filter(c => !c.pinned && c.type !== 'room');

  // Режим поиска — редкий путь, полная перерисовка
  if (q || S.searchResults) {
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
    _chatRowCache.clear();
    applyAvatars();
    return;
  }

  // Обычный режим: keyed-обновление — меняются только реально изменившиеся строки,
  // остальные DOM-узлы (и их аватары) не трогаются — нет мигания при каждом событии
  const items = [];
  if (!filtered.length) {
    items.push({ key: 'empty', html: '<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px">Нет чатов</div>' });
  } else {
    if (pinned.length) {
      items.push({ key: 'label-pinned', html: '<div class="chat-list-section-label">Закреплённые</div>' });
      pinned.forEach(c => items.push({ key: 'chat-' + c.id, html: renderChatRow(c) }));
    }
    items.push({ key: 'label-all', html: `<div class="chat-list-section-label" style="${pinned.length?'padding-top:12px':''}">Все чаты</div>` });
    rest.forEach(c => items.push({ key: 'chat-' + c.id, html: renderChatRow(c) }));
  }
  syncChatListKeyed(list, items);
  applyAvatars();
}

function renderChatRow(c) {
  const name = chatName(c);
  const u = S.unread[c.id]||0;
  const lm = c.last_message;
  let preview = lm ? (lm.deleted ? 'Сообщение удалено' : (lm.text || (lm.attachment ? (lm.attachment.mime?.startsWith('image/') ? '🖼 Изображение' : '📎 ' + (lm.attachment.name || 'Файл')) : ''))) : 'Нет сообщений';
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
      <div class="av av-md ${chatAvatarClass(c)}${c.type==='direct'?' av-round':' av-sq'}" data-av-chat="${c.id}">${chatIcon(c)}</div>
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
        ${(S.unreadMentions[c.id]||0)>0?`<div class="unread-badge" style="background:var(--accent)" title="Вас упомянули">@</div>`:''}
        ${u>0?`<div class="unread-badge">${u}</div>`:''}
      </div>
    </div>
  </div>`;
}

let _searchTimer = null;
function clearSearch() {
  const inp = document.getElementById('search');
  if (inp) { inp.value = ''; inp.focus(); }
  const btn = document.getElementById('search-clear');
  if (btn) btn.style.display = 'none';
  filterChats();
}
function filterChats() {
  renderChatList();
  const q = document.getElementById('search').value.trim();
  const btn = document.getElementById('search-clear');
  if (btn) btn.style.display = q ? '' : 'none';
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

// Заменяет содержимое chat-main, сохраняя #chat-input-bar (он внутри chat-main,
// поэтому при innerHTML = ... будет уничтожен — сначала извлекаем, потом возвращаем).
function setChatMainContent(html) {
  const main = document.getElementById('chat-main');
  const ib = document.getElementById('chat-input-bar');
  if (ib && ib.parentNode === main) main.removeChild(ib);
  main.innerHTML = html;
  if (ib) { ib.style.display = 'none'; main.appendChild(ib); }
}

// ── OPEN CHAT ──
async function openChat(chatId, aroundId = null) {
  S.activeChatId = chatId;
  S.chatHasMore = false;
  S.chatOldestId = null;
  S.chatHasMoreAfter = false;
  S.chatNewestId = null;
  S.statusApplied = {};
  _loadingMore = false;
  const _unreadAtOpen = S.unread[chatId] || 0;
  S.unread[chatId] = 0;
  S.unreadMentions[chatId] = 0;
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
  const nameClickable = (isGroup || isRoom) ? `style="cursor:pointer" onclick="openGroupInfo(${chatId})"` : '';

  const main = document.getElementById('chat-main');
  setChatMainContent(`
    <div class="chat-header">
      <button class="icon-btn mobile-back-btn" onclick="mobileBack()" title="Назад" style="flex-shrink:0">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <div class="av-wrap">
        <div class="av av-md ${chatAvatarClass(chat)}${chat.type==='direct'?' av-round':' av-sq'}" data-av-chat="${chat.id}">${chatIcon(chat)}</div>
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
    </div>`);

  const inputBar = document.getElementById('chat-input-bar');
  inputBar.style.display = '';
  inputBar.innerHTML = `
    <div class="chat-input-wrap" id="input-wrap">
      <div class="composer-inner">
        <div id="image-preview-bar" style="display:none" class="input-reply-bar">
          <img class="img-preview-thumb" src="" style="width:40px;height:40px;object-fit:cover;border-radius:6px;flex-shrink:0">
          <div class="attach-preview-icon" style="display:none;width:40px;height:40px;border-radius:6px;flex-shrink:0;background:var(--surface2);display:none;align-items:center;justify-content:center">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          </div>
          <div class="reply-bar-content">
            <div class="reply-bar-name">Вложение</div>
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
          <div class="ep-grid" id="ep-grid"><div class="ep-grid-inner">${EMOJIS.map(em=>`<button class="emoji-item" onclick="insertEmoji('${em}')">${em}</button>`).join('')}</div></div>
          <button class="composer-icon-btn" title="Эмодзи" onclick="toggleEmojiPicker(event)">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 13s1.5 3 4 3 4-3 4-3"/><circle cx="9" cy="9" r="1" fill="currentColor"/><circle cx="15" cy="9" r="1" fill="currentColor"/></svg>
          </button>
          <button class="composer-icon-btn" title="Прикрепить файл" onclick="pickFile()">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          </button>
          <input type="file" id="file-input" accept="*" style="display:none" onchange="onFilePicked(this)">
          <textarea id="msg-input" rows="1" placeholder="Сообщение…" onkeydown="handleKey(event)" oninput="onMsgInput(this)"></textarea>
          <button class="send-btn" id="send-btn" onmousedown="event.preventDefault()" onclick="sendOrEdit()">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </button>
        </div>
      </div>
    </div>`;

  requestAnimationFrame(syncInputBarHeight);
  applyAvatars();
  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) { sendBtn.style.background='transparent'; sendBtn.style.color='var(--muted)'; sendBtn.style.boxShadow='none'; }
  if (S.ws && isViewing()) S.ws.send(JSON.stringify({type:'read', chat_id: chatId}));

  const msgsEl = document.getElementById('messages');
  if (msgsEl) {
    msgsEl.innerHTML = `<div class="skeleton-wrap">${[200,280,160,240,120].map((w,i) =>
      `<div class="skeleton-msg ${i%2===0?'theirs':'mine'}">
        <div class="skeleton-av"></div>
        <div class="skeleton-bubble" style="width:${w}px"></div>
      </div>`).join('')}</div>`;
  }
  const data = await api('GET', aroundId ? `/messages/chat/${chatId}?around=${aroundId}&limit=50` : `/messages/chat/${chatId}?limit=50`);
  if (data && S.activeChatId === chatId) {
    S.chatHasMore = data.hasMore;
    S.chatHasMoreAfter = !!data.hasMoreAfter;
    S.chatOldestId = data.messages[0]?.id ?? null;
    S.chatNewestId = data.messages[data.messages.length - 1]?.id ?? null;
    renderMessages(data.messages, !aroundId);
    if (aroundId) {
      requestAnimationFrame(() => scrollToMsg(aroundId, true));
    } else {
      insertUnreadDivider(data.messages, _unreadAtOpen);
    }
    const msgsEl2 = document.getElementById('messages');
    if (msgsEl2) {
      msgsEl2.addEventListener('scroll', onMessagesScroll, { passive: true });
      // Touch swipe-right on messages = reply (web only)
      addSwipeReply(msgsEl2);
    }
  }
  if (S.activeChatId !== chatId) return;

  // Показываем панель чата до autoResize: chat-main нужен display:flex,
  // иначе scrollHeight=0 и textarea получает height:0px
  openMobileChat();

  const inputEl = document.getElementById('msg-input');
  if (inputEl) {
    inputEl.value = S.drafts[chatId] || '';
    autoResize(inputEl);
    onMsgInput(inputEl, true);
  }
  if (!_isMobile()) inputEl?.focus();
}

// ── SWIPE TO REPLY (touch) ──
const EDGE_BACK_ZONE = 30; // px от левого края — зона жеста «назад»

function addSwipeReply(container) {
  let startX = 0, startY = 0, swipeEl = null, dirLocked = false, backMode = false;
  const chatMain = () => document.getElementById('chat-main');

  container.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    backMode = startX < EDGE_BACK_ZONE; // свайп от левого края = возврат к списку
    swipeEl = backMode ? null : e.target.closest('[data-msg-id]');
    dirLocked = false;
  }, { passive: true });

  container.addEventListener('touchmove', e => {
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;

    if (backMode) {
      if (!dirLocked) {
        if (Math.abs(dy) > Math.abs(dx) || Math.abs(dx) < 8) return;
        dirLocked = true;
      }
      if (dx <= 0) return;
      e.preventDefault();
      const cm = chatMain();
      const shift = `translateX(${Math.min(dx, window.innerWidth)}px)`;
      if (cm) { cm.style.transform = shift; cm.style.transition = 'none'; }
      return;
    }

    if (!swipeEl) return;
    // Определяем направление по первым ~8px движения
    if (!dirLocked) {
      if (Math.abs(dy) > Math.abs(dx) || Math.abs(dx) < 6) return;
      dirLocked = true;
    }
    if (dx <= 0) { // ответ — только свайп вправо
      swipeEl.style.transform = ''; swipeEl.style.transition = 'transform .2s';
      swipeEl = null; return;
    }
    e.preventDefault();
    const shift = Math.min(dx * 0.45, 50);
    swipeEl.style.transform = `translateX(${shift}px)`;
    swipeEl.style.transition = 'none';
  }, { passive: false });

  container.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - startX;

    if (backMode) {
      const cm = chatMain();
      if (cm) cm.style.transition = _CHAT_EASE;
      if (dx > window.innerWidth * 0.35) {
        if (cm) cm.style.transform = `translateX(${window.innerWidth}px)`;
        document.querySelector('.sidebar')?.classList.remove('mobile-hidden');
        setTimeout(() => mobileBack(false), 320);
      } else {
        if (cm) cm.style.transform = '';
        cm?.addEventListener('transitionend', () => {
          if (cm) { cm.style.transform = ''; cm.style.transition = ''; }
        }, { once: true });
      }
      backMode = false;
      return;
    }

    if (!swipeEl) return;
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
  const touch = e.touches[0];
  const msgEl = e.target.closest('[data-msg-id]');
  if (msgEl) {
    _longPressTimer = setTimeout(() => {
      const msgId = parseInt(msgEl.dataset.msgId);
      const sentAt = parseInt(msgEl.dataset.sentAt || '0');
      const isMine = parseInt(msgEl.dataset.senderId) === S.user?.id;
      showCtxMenu({ clientX: touch.clientX, clientY: touch.clientY, preventDefault: ()=>{} }, msgId, sentAt, isMine);
    }, 600);
    return;
  }
  // Long-press по элементу списка чатов — выезжающий снизу блок с удалением
  const chatEl = e.target.closest('[data-chat-id]');
  if (chatEl) {
    _longPressTimer = setTimeout(() => {
      const chatId = parseInt(chatEl.dataset.chatId);
      openChatSheet(chatId);
    }, 600);
  }
}, { passive: true });
document.addEventListener('touchend', () => { clearTimeout(_longPressTimer); _longPressTimer = null; }, { passive: true });
document.addEventListener('touchmove', () => { clearTimeout(_longPressTimer); _longPressTimer = null; }, { passive: true });

// ── EMOJI PICKER ──
const EMOJIS = ['😀','😂','😍','😎','🤔','😭','😡','👍','👎','❤️','🔥','🎉','👏','🙏','💪','🤝','😊','🥳','😴','🤣','💯','✅','❌','🚀','⭐','💡','📌','🎯','💬','📷'];

function closeEmojiPicker() {
  document.getElementById('ep-grid')?.classList.remove('open');
}

function toggleEmojiPicker(e) {
  e.stopPropagation();
  document.getElementById('ep-grid')?.classList.toggle('open');
}

function insertEmoji(em) {
  const input = document.getElementById('msg-input');
  if (!input) return;
  const start = input.selectionStart, end = input.selectionEnd;
  input.value = input.value.slice(0, start) + em + input.value.slice(end);
  input.selectionStart = input.selectionEnd = start + em.length;
  input.focus();
  autoResize(input);
  closeEmojiPicker();
}

// ── RENDER MESSAGES ──
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
  // Ждём завершения layout перед скроллом (иначе scrollHeight ещё не актуален)
  _stickBottom = stick;
  if (stick) requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight;
  });
}

function onMessagesScroll() {
  const container = document.getElementById('messages');
  if (!container) return;
  // Отслеживаем, находится ли пользователь у нижнего края (для авто-прокрутки)
  const dist = container.scrollHeight - container.scrollTop - container.clientHeight;
  _stickBottom = dist < 80 && !S.chatHasMoreAfter;
  if (S.chatHasMore && !_loadingMore && container.scrollTop < 80) loadMoreMessages();
  if (S.chatHasMoreAfter && !_loadingMore && dist < 80) loadMoreAfter();
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

function rolePillHtml(tag) {
  if (!tag) return '';
  const tagLow = tag.toLowerCase();
  let cls = 'default';
  if (tagLow === 'developer') cls = 'teal';
  else if (tagLow === 'tester') cls = 'indigo';
  return `<span class="role-pill ${cls}">${esc(tag)}</span>`;
}

function senderNameClass(tag) {
  if (!tag) return 'default';
  const t = (tag||'').toLowerCase();
  if (t === 'developer') return 'teal';
  if (t === 'tester') return 'indigo';
  return 'default';
}

function renderMsgIRC(m, isGroup) {
  if (m.status && m.id > 0) S.msgStatus[m.id] = { ...m.status };
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

  const ircTagHtml = m.sender_tag ? rolePillHtml(m.sender_tag) : '';
  const senderCls = senderNameClass(m.sender_tag);
  const header = isGroup
    ? `<div class="irc-header irc-header-grouped">
        <div class="irc-meta"><span class="status-wrap">${statusIcon}</span><span class="irc-time">${time}</span></div>
       </div>`
    : `<div class="irc-header">
        <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0">
          <span class="irc-name msg-sender-name ${senderCls}${mine?' mine':''}">${senderName}</span>${ircTagHtml}
        </div>
        <div class="irc-meta"><span class="status-wrap">${statusIcon}</span><span class="irc-time">${time}</span></div>
       </div>`;

  const att = m.attachment;
  let attachHtml = '';
  if (!isDeleted && att?.url) {
    if (att.expired) {
      const isImg = att.mime?.startsWith('image/');
      attachHtml = isImg
        ? `<div class="bubble-image bubble-expired"><span>Файл удалён</span></div>`
        : `<div class="bubble-file bubble-expired">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.4"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <div class="bubble-file-info"><div class="bubble-file-name" style="opacity:.4">${att.name||'Файл'}</div><div class="bubble-file-size">Файл удалён</div></div>
          </div>`;
    } else {
      const attUrl = `${httpProto()}://${S.server}${att.url}`;
      if (att.mime?.startsWith('image/')) {
        attachHtml = `<div class="bubble-image" onclick="openLightbox('${attUrl}','${(att.name||'image').replace(/'/g,"\\'")}')"><img src="${httpProto()}://${S.server}${att.thumb || att.url}" loading="lazy"></div>`;
      } else {
        const sizeFmt = att.size ? (att.size > 1048576 ? (att.size/1048576).toFixed(1)+' МБ' : Math.round(att.size/1024)+' КБ') : '';
        attachHtml = `<div class="bubble-file" onclick="downloadAttachment('${attUrl}','${(att.name||'file').replace(/'/g,"\\'")}')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <div class="bubble-file-info"><div class="bubble-file-name">${att.name||'Файл'}</div>${sizeFmt?`<div class="bubble-file-size">${sizeFmt}</div>`:''}</div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </div>`;
      }
    }
  }

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

// Умный скролл к низу после появления сообщения: своё — всегда, чужое — если пользователь
// у дна. Учитывает асинхронную догрузку картинок и вложений (scrollHeight после загрузки
// вырастет), повторно вызывая прокрутку при `load`/`error` на каждом img.
function stickToBottom(container, newEl, m) {
  const dist = container.scrollHeight - container.scrollTop - container.clientHeight;
  if (!(m._optimistic || dist < 120)) return;
  _stickBottom = true;
  const behavior = m._optimistic ? 'instant' : 'smooth';
  const toBottom = () => container.scrollTo({ top: container.scrollHeight, behavior });
  requestAnimationFrame(toBottom);
  newEl?.querySelectorAll('img').forEach(img => {
    if (img.complete) return;
    img.addEventListener('load',  toBottom, { once: true });
    img.addEventListener('error', toBottom, { once: true });
  });
}

function appendMsg(m) {
  const container = document.getElementById('messages');
  if (!container) return;
  if (m.id > 0 && container.querySelector(`[data-msg-id="${m.id}"]`)) return;
  const chat = S.chats.find(c=>c.id===S.activeChatId);
  const allMsgs = [...container.querySelectorAll('[data-msg-id]')];
  const lastEl = allMsgs[allMsgs.length - 1];
  let grouped = false;
  if (lastEl && !m.deleted) {
    const prevSenderId = parseInt(lastEl.dataset.senderId || '0');
    const prevTime = parseInt(lastEl.dataset.sentAt || '0');
    grouped = sameTimeGroup({ sender_id: prevSenderId, sent_at: prevTime }, m);
  }
  const isChatGroupAppend = chat?.type==='group' || chat?.type==='room';
  container.insertAdjacentHTML('beforeend', renderMsg(m, isChatGroupAppend, false, grouped, true));
  const newEl = container.lastElementChild;
  if (newEl && !m._optimistic) newEl.classList.add('msg-new');
  stickToBottom(container, newEl, m);
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
// ── @MENTION AUTOCOMPLETE ──
let _mentionIdx = -1;

function _getMentionQuery(el) {
  const m = el.value.slice(0, el.selectionStart).match(/@(\S*)$/);
  return m ? m[1] : null;
}
function _mentionMembers() {
  const chat = S.chats.find(c => c.id === S.activeChatId);
  if (chat?.type !== 'group' && chat?.type !== 'room') return null;
  return (chat.members || []).filter(m => m.id !== S.user.id);
}
function _updateMentionPopup(el) {
  const query = _getMentionQuery(el);
  const all = _mentionMembers();
  if (query === null || !all) { hideMentionPopup(); return; }
  const q = query.toLowerCase();
  const filtered = q
    ? all.filter(m => (m.display_name||'').toLowerCase().includes(q) || m.username.toLowerCase().includes(q))
    : all;
  if (!filtered.length) { hideMentionPopup(); return; }
  const popup = document.getElementById('mention-popup');
  _mentionIdx = -1;
  popup.innerHTML = filtered.map(m =>
    `<div class="mention-item" data-name="${esc(m.display_name||m.username)}" onclick="insertMention('${esc(m.display_name||m.username)}')">
      <div class="av av-sm av-round ${avatarColor(m.id)}" data-av-user="${m.id}">${initials(m.display_name)}</div>
      <div><div class="mn-name">${esc(m.display_name||m.username)}</div><div class="mn-login">@${esc(m.username)}</div></div>
    </div>`
  ).join('');
  applyAvatars();
  const pill = document.getElementById('composer-pill');
  if (pill) {
    const rect = pill.getBoundingClientRect();
    popup.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
    popup.style.left = rect.left + 'px';
    popup.style.width = Math.min(rect.width, 280) + 'px';
    popup.style.display = 'block';
  }
}
function hideMentionPopup() {
  const p = document.getElementById('mention-popup');
  if (p) { p.style.display = 'none'; p.innerHTML = ''; }
  _mentionIdx = -1;
}
function _mentionMove(dir) {
  const popup = document.getElementById('mention-popup');
  const items = popup?.querySelectorAll('.mention-item');
  if (!items?.length) return;
  items[_mentionIdx]?.classList.remove('mn-active');
  _mentionIdx = (_mentionIdx + dir + items.length) % items.length;
  items[_mentionIdx].classList.add('mn-active');
  items[_mentionIdx].scrollIntoView({ block: 'nearest' });
}
function insertMention(name) {
  const el = document.getElementById('msg-input');
  if (!el) return;
  const cursor = el.selectionStart;
  const before = el.value.slice(0, cursor);
  const m = before.match(/@(\S*)$/);
  if (!m) return;
  const newBefore = before.slice(0, before.length - m[0].length) + '@' + name + ' ';
  el.value = newBefore + el.value.slice(cursor);
  el.selectionStart = el.selectionEnd = newBefore.length;
  el.focus();
  autoResize(el);
  hideMentionPopup();
}

function handleKey(e) {
  const popup = document.getElementById('mention-popup');
  if (popup?.style.display !== 'none' && popup?.innerHTML) {
    if (e.key === 'ArrowDown') { e.preventDefault(); _mentionMove(1); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); _mentionMove(-1); return; }
    if (e.key === 'Escape')    { hideMentionPopup(); return; }
    if (e.key === 'Enter' && _mentionIdx >= 0) {
      e.preventDefault();
      popup.querySelectorAll('.mention-item')[_mentionIdx]?.click();
      return;
    }
  }
  if (e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendOrEdit(); }
}

const typingTimers = {};
let typingSendTimer = null;

function _updateSendBtn(el) {
  const sendBtn = document.getElementById('send-btn');
  if (!sendBtn) return;
  const hasDraft = el.value.trim().length > 0;
  sendBtn.style.background = hasDraft ? 'var(--accent)' : 'transparent';
  sendBtn.style.color = hasDraft ? '#0c0e10' : 'var(--muted)';
  sendBtn.style.boxShadow = 'none';
}

// silent=true — восстановление черновика при открытии чата: не шлём typing собеседнику
function onMsgInput(el, silent = false) {
  autoResize(el);
  _updateMentionPopup(el);
  // Сохраняем черновик для текущего чата, чтобы он не терялся при переключении
  if (S.activeChatId) {
    if (el.value) S.drafts[S.activeChatId] = el.value;
    else delete S.drafts[S.activeChatId];
    saveDrafts();
  }
  _updateSendBtn(el);
  if (silent || !S.activeChatId || S.ws?.readyState !== 1) return;
  if (!typingSendTimer) {
    S.ws.send(JSON.stringify({ type: 'typing', chat_id: S.activeChatId }));
  }
  clearTimeout(typingSendTimer);
  typingSendTimer = setTimeout(() => { typingSendTimer = null; }, 1000);
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
  const sh = el.scrollHeight;
  el.style.height = Math.max(20, Math.min(sh, 120)) + 'px';
  if (sh > 120) el.style.overflow = 'auto';
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
    sender_tag: S.user.tag || null,
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
  e.preventDefault(); e.stopPropagation?.();
  S.ctx.messageId = msgId;
  S.ctx.canEdit = isMine && (Date.now()/1000 - sentAt) < (S.editLimit || 120);
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
  const margin = 8;
  const _z = (S.settings.uiScale || 100) / 100;
  const cx = e.clientX / _z, cy = e.clientY / _z;
  // По центру над точкой тапа
  let x = cx - mw / 2;
  let y = cy - mh - margin;
  if (x + mw + margin > window.innerWidth)  x = window.innerWidth - mw - margin;
  if (x < margin) x = margin;
  // Если над пальцем не влезает — показываем под ним
  if (y < margin) y = cy + margin;
  if (y + mh + margin > window.innerHeight) y = window.innerHeight - mh - margin;
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
  const el = document.querySelector(`[data-msg-id="${msgId}"] .irc-text`);
  if (!el) return;
  navigator.clipboard.writeText(el.innerText).catch(() => {});
}

function ctxReply() {
  hideCtxMenu();
  const msgId = S.ctx.messageId;
  if (!msgId) return;
  const textEl = document.querySelector(`[data-msg-id="${msgId}"] .irc-text`);
  const text = textEl?.innerText || '';
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

// ── FILE / IMAGE ATTACH ──
let _pendingAttachment = null;
let _uploadSettings = {
  image: { maxSizeMb: 10, extensions: ['jpeg','jpg','png','gif','webp'] },
  file:  { maxSizeMb: 50, extensions: [] },
};

async function loadUploadSettings() {
  try {
    const res = await fetch(`${httpProto()}://${S.server}/api/upload/settings`, {
      headers: { 'Authorization': `Bearer ${S.token}` },
    });
    if (res.ok) _uploadSettings = await res.json();
  } catch {}
}

function pickImage() {
  document.getElementById('img-file-input')?.click();
}

function pickFile() {
  document.getElementById('file-input')?.click();
}

async function onImagePicked(input) {
  const file = input.files?.[0];
  if (!file) return;
  input.value = '';
  await uploadFile(file);
}

async function onFilePicked(input) {
  const file = input.files?.[0];
  if (!file) return;
  input.value = '';
  await uploadFile(file);
}

async function uploadFile(file) {
  if (!file) return;
  const isImage = file.type.startsWith('image/');
  const cfg = isImage ? _uploadSettings.image : _uploadSettings.file;
  const ext = (file.name.split('.').pop() || '').toLowerCase();

  if (file.size > cfg.maxSizeMb * 1024 * 1024) {
    showActionToast(`Файл слишком большой (макс. ${cfg.maxSizeMb} МБ)`);
    return;
  }
  if (cfg.extensions.length > 0 && !cfg.extensions.includes(ext)) {
    showActionToast(`Расширение .${ext} не разрешено`);
    return;
  }

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
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showActionToast(err.error || 'Ошибка загрузки');
      if (sendBtn && !document.getElementById('msg-input')?.value.trim()) {
        sendBtn.style.background='transparent'; sendBtn.style.color='var(--muted)'; sendBtn.style.boxShadow='none';
      }
      return;
    }
    _pendingAttachment = await res.json();
    showAttachmentPreviewBar();
  } catch {
    if (sendBtn && !document.getElementById('msg-input')?.value.trim()) {
      sendBtn.style.background='transparent'; sendBtn.style.color='var(--muted)'; sendBtn.style.boxShadow='none';
    }
  }
}

// Keep alias for backward-compat callers (drag-drop, paste)
async function uploadImageFile(file) { return uploadFile(file); }

function showAttachmentPreviewBar() {
  const bar = document.getElementById('image-preview-bar');
  if (!bar) return;
  const att = _pendingAttachment;
  if (!att) { bar.style.display = 'none'; return; }
  bar.style.display = '';
  const isImage = att.mime?.startsWith('image/');
  const thumb = bar.querySelector('.img-preview-thumb');
  if (thumb) { thumb.src = isImage ? `${httpProto()}://${S.server}${att.url}` : ''; thumb.style.display = isImage ? '' : 'none'; }
  const icon = bar.querySelector('.attach-preview-icon');
  if (icon) icon.style.display = isImage ? 'none' : '';
  bar.querySelector('.img-preview-name').textContent = att.name || (isImage ? 'Изображение' : 'Файл');
}

function showImagePreviewBar() { showAttachmentPreviewBar(); }

function clearImagePreview() {
  _pendingAttachment = null;
  const bar = document.getElementById('image-preview-bar');
  if (bar) bar.style.display = 'none';
  const sendBtn = document.getElementById('send-btn');
  if (sendBtn && !document.getElementById('msg-input')?.value.trim()) {
    sendBtn.style.background='transparent'; sendBtn.style.color='var(--muted)'; sendBtn.style.boxShadow='none';
  }
}

function openLightbox(url, filename) {
  let lb = document.getElementById('lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'lightbox';
    lb.onclick = () => closeLightbox();
    lb.innerHTML = `<img id="lightbox-img">
      <button id="lightbox-download" title="Скачать" onclick="event.stopPropagation();downloadAttachment(document.getElementById('lightbox').dataset.url, document.getElementById('lightbox').dataset.filename)">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </button>`;
    document.body.appendChild(lb);
  }
  document.getElementById('lightbox-img').src = url;
  lb.dataset.url = url;
  lb.dataset.filename = filename || 'image';
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

function downloadAttachment(url, filename) {
  if (window.electron?.downloadFile) {
    window.electron.downloadFile({ url, filename });
  } else {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'file';
    a.target = '_blank';
    a.rel = 'noopener';
    a.click();
  }
}

function scrollToMsg(msgId, force = false) {
  const el = document.querySelector(`[data-msg-id="${msgId}"]`);
  // Сообщения нет в DOM (глубоко в истории) — перезагружаем чат окном вокруг него
  if (!el) { if (S.activeChatId) openChat(S.activeChatId, msgId); return; }
  const msgs = document.getElementById('messages');
  const rect = el.getBoundingClientRect();
  const containerRect = msgs ? msgs.getBoundingClientRect() : null;
  const isVisible = containerRect
    ? rect.top >= containerRect.top && rect.bottom <= containerRect.bottom
    : false;
  if ((force || !isVisible) && msgs && containerRect) {
    const offset = rect.top - containerRect.top - msgs.clientHeight / 2 + el.offsetHeight / 2;
    // force: мгновенный скролл; smooth-прокрутка триггерит onMessagesScroll на промежуточных
    // scrollTop<80 и вызывает loadMoreMessages, что уводит позицию.
    if (force) msgs.scrollTop = msgs.scrollTop + offset;
    else msgs.scrollBy({ top: offset, behavior: 'smooth' });
  }
  el.classList.add('msg-highlight');
  setTimeout(() => el.classList.remove('msg-highlight'), 1500);
}
function hideCtxMenu() {
  document.getElementById('ctx-menu').classList.remove('open');
}

function ctxEdit() {
  hideCtxMenu();
  if (!S.ctx.canEdit) return;
  const el = document.querySelector(`[data-msg-id="${S.ctx.messageId}"] .irc-text`);
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
    if (!ts) return null;
    const d = new Date(ts * 1000);
    return d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', {hour:'2-digit', minute:'2-digit'});
  }

  document.querySelector('#modal-msg-info .mi-title').textContent = data.chat_type === 'direct' ? 'Информация' : 'Прочитано';

  let body;

  if (data.chat_type === 'direct') {
    const s = data.statuses[0];
    const sentDone  = !!data.sent_at;
    const delivDone = !!s?.delivered_at;
    const readDone  = !!s?.read_at;

    const icoSingleTeal = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#29d6b8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    const icoDblTeal    = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#29d6b8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 5 7 16 2 11"/><polyline points="22 5 13 16 8 11"/></svg>`;
    const icoDblGray    = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#5b6169" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 5 7 16 2 11"/><polyline points="22 5 13 16 8 11"/></svg>`;

    function tlStep(label, sub, done, ico, showConn) {
      const dc = done ? 'mi-done' : 'mi-pending';
      const pc = done ? '' : ' mi-pending';
      const conn = showConn ? `<div class="mi-connector ${dc}"></div>` : '';
      return `<div class="mi-step">
        <div class="mi-step-left"><div class="mi-icon ${dc}">${ico}</div>${conn}</div>
        <div class="mi-step-right">
          <div class="mi-step-name${pc}">${label}</div>
          <div class="mi-step-sub${pc}">${sub}</div>
        </div>
      </div>`;
    }

    body = `<div class="mi-timeline">
      ${tlStep('Отправлено', fmtDt(data.sent_at) || '—', sentDone, icoSingleTeal, true)}
      ${tlStep('Доставлено', delivDone ? fmtDt(s?.delivered_at) : 'пока не доставлено', delivDone, delivDone ? icoDblTeal : icoDblGray, true)}
      ${tlStep('Прочитано', readDone ? fmtDt(s?.read_at) : 'пока не прочитано', readDone, readDone ? icoDblTeal : icoDblGray, false)}
    </div>`;

  } else {
    const total = data.statuses.length;
    const readUsers = data.statuses.filter(s => s.read_at);
    if (readUsers.length === 0) {
      body = `<div class="mi-group-count">0 из ${total} участников</div><div class="mi-empty">Пока никто не прочитал</div>`;
    } else {
      body = `<div class="mi-group-count">${readUsers.length} из ${total} участников</div>`;
      body += readUsers.map(s => `<div class="mi-user-row">
        <div class="av mi-av ${avatarColor(s.user_id)}" data-av-user="${s.user_id}">${initials(s.display_name)}</div>
        <div class="mi-user-name">${esc(s.display_name)}</div>
        <div class="mi-user-time">${fmtDt(s.read_at)}</div>
      </div>`).join('');
    }
  }

  document.getElementById('msg-info-body').innerHTML = body;
  if (data.chat_type !== 'direct') applyAvatars();
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
    setChatMainContent(`<div class="empty-state"><div class="empty-icon">💬</div><div class="empty-title">Electron</div><div class="empty-sub">Выберите чат или создайте новый</div></div>`);
    document.getElementById('chat-main').classList.remove('mobile-open');
    document.querySelector('.sidebar')?.classList.remove('mobile-hidden');
  }
  renderChatList();
}

async function leaveGroup(chatId) {
  const ok = await showConfirm('Выйти из группы?', 'Выйти');
  if (!ok) return;
  await api('POST', `/chats/${chatId}/leave`);
  S.activeChatId = null;
  setChatMainContent(`<div class="empty-state"><div class="empty-icon">💬</div><div class="empty-title">Electron</div><div class="empty-sub">Выберите чат или создайте новый</div></div>`);
  document.getElementById('chat-main').classList.remove('mobile-open');
  document.querySelector('.sidebar')?.classList.remove('mobile-hidden');
  loadChats();
}

// ── WEBSOCKET ──
function connectWS() {
  const ws = new WebSocket(`${wsProto()}://${S.server}/ws?token=${S.token}`);
  S.ws = ws;

  ws.onmessage = async e => {
    if (ws !== S.ws) return;
    let data; try { data=JSON.parse(e.data); } catch { return; }

    if (data.type==='pong') { ws._pongOk = true; return; }

    if (data.type==='connected') { S.editLimit = data.edit_time_limit || 120; return; }

    if (data.type==='message') {
      const { message } = data;
      const chatId = message.chat_id;
      const chat = S.chats.find(c=>c.id===chatId);
      if (chat) chat.last_message = message;
      // Если мы вглуби истории (низ не догружен) — не аппендим, придёт при догрузке
      if (S.activeChatId===chatId && !S.chatHasMoreAfter) {
        if (message.sender_id === S.user.id) {
          document.querySelector('[data-optimistic="1"]')?.remove();
        }
        appendMsg(message);
        S.chatNewestId = message.id;
        if (isViewing() && S.ws?.readyState===1) {
          S.ws.send(JSON.stringify({type:'read', chat_id:chatId}));
          S.ws.send(JSON.stringify({type:'delivered', message_id:message.id}));
        } else if (!isViewing() && message.sender_id !== S.user.id) {
          S.unread[chatId] = (S.unread[chatId]||0)+1;
          if (message.mentions?.includes(S.user.id)) S.unreadMentions[chatId] = (S.unreadMentions[chatId]||0)+1;
          const title = chatName(chat) || 'Electron';
          const body = `${message.sender_name}: ${message.text || (message.attachment ? (message.attachment.mime?.startsWith('image/') ? '🖼 Изображение' : '📎 ' + (message.attachment.name || 'Файл')) : '')}`;
          webNotify(title, body, chatId);
          playNotificationSound();
          if (S.ws?.readyState===1) S.ws.send(JSON.stringify({type:'delivered', message_id:message.id}));
        }
      } else if (message.sender_id === S.user.id) {
        // Своё сообщение, отправленное с другого устройства — чат прочитан мной
        S.unread[chatId] = 0;
      } else {
        S.unread[chatId] = (S.unread[chatId]||0)+1;
        if (message.mentions?.includes(S.user.id)) S.unreadMentions[chatId] = (S.unreadMentions[chatId]||0)+1;
        const chat2 = S.chats.find(c=>c.id===chatId);
        const title = chatName(chat2) || 'Electron';
        const body = `${message.sender_name}: ${message.text || (message.attachment ? (message.attachment.mime?.startsWith('image/') ? '🖼 Изображение' : '📎 ' + (message.attachment.name || 'Файл')) : '')}`;
        webNotify(title, body, chatId);
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

    if (data.type==='reload_chats') { loadChats(); }
    if (data.type==='chat_deleted') { removeChatLocally(data.chat_id); }

    if (data.type==='chat_read') {
      // Чат прочитан на другом устройстве этого пользователя
      S.unread[data.chat_id] = 0;
      updateUnreadTotal();
      renderChatList();
    }

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
            const target = msgEl.querySelector('.irc-content');
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
      if (data.last_seen) S.lastSeen[data.user_id] = data.last_seen;
      // Обновляем подпись в шапке открытого личного чата («в сети» / «был(а) в …»)
      const activeChat = S.chats.find(c=>c.id===S.activeChatId);
      if (activeChat?.type === 'direct' && getPeerUserId(activeChat) === data.user_id) {
        const subEl = document.querySelector('.ch-sub');
        if (subEl) subEl.textContent = peerStatusText(data.user_id);
      }
      const isOnline = data.status === 'online';
      document.querySelectorAll(`.presence-dot[data-user-id="${data.user_id}"]`).forEach(dot => {
        dot.style.display = isOnline ? '' : 'none';
      });
    }

    if (data.type==='status_update') {
      const m = data.message;
      if (m.status) S.msgStatus[m.id] = { ...m.status };
      if (S.activeChatId===m.chat_id && m.sender_id===S.user.id) {
        const wrap = document.querySelector(`[data-msg-id="${m.id}"] .status-wrap`);
        if (wrap) wrap.innerHTML = renderStatus(m.status);
      }
    }

    if (data.type==='status_range') {
      if (data.chat_id === S.activeChatId) {
        const eventKey = `${data.kind}:${data.reader_id}`;
        document.querySelectorAll('[data-msg-id]').forEach(el => {
          const id = parseInt(el.dataset.msgId);
          if (!(id >= data.min_id && id <= data.max_id)) return;
          if (parseInt(el.dataset.senderId) !== S.user.id) return;
          const st = S.msgStatus[id];
          if (!st) return;
          if (!S.statusApplied[id]) S.statusApplied[id] = new Set();
          if (S.statusApplied[id].has(eventKey)) return;
          S.statusApplied[id].add(eventKey);
          if (data.kind === 'read') {
            st.read = Math.min(st.total, st.read + 1);
            st.delivered = Math.max(st.delivered, st.read);
          } else {
            st.delivered = Math.min(st.total, st.delivered + 1);
          }
          const wrap = el.querySelector('.status-wrap');
          if (wrap) wrap.innerHTML = renderStatus(st);
        });
      }
    }

    if (data.type==='chat_updated') {
      // Точечное обновление чата без refetch всего списка
      const idx = S.chats.findIndex(c => c.id === data.chat.id);
      if (idx >= 0) S.chats[idx] = data.chat; else S.chats.push(data.chat);
      renderChatList();
      if (S.activeChatId === data.chat.id) {
        const nameEl = document.querySelector('.ch-name');
        if (nameEl) nameEl.textContent = chatName(data.chat);
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
      renderChatList();
    }

    if (data.type === 'force_logout') { logout(); }
  };

  ws.onclose = (event) => {
    clearInterval(ws._hb);
    if (event.code === 1008) { logout(); return; }
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
    // Heartbeat: держим соединение живым и ловим «зомби»-сокеты в фоне.
    // Если на ping не пришёл pong — соединение мёртвое, закрываем → реконнект.
    ws._pongOk = true;
    clearInterval(ws._hb);
    ws._hb = setInterval(() => {
      if (ws.readyState !== 1) return;
      if (!ws._pongOk) { try { ws.close(); } catch {} return; }
      ws._pongOk = false;
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch {}
    }, 20000);
    setTimeout(() => {
      const initStatus = document.hidden ? 'offline' : 'online';
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
    }, 300);
  };
  ws.onerror = () => ws.close();
}

function updateUnreadTotal() {
  const total = Object.values(S.unread).reduce((a,b)=>a+b,0);
  document.title = total > 0 ? `(${total}) Electron` : 'Electron';
  // Счётчик на иконке установленного PWA (iOS 16.4+, Chrome, Edge)
  try {
    if (total > 0) navigator.setAppBadge?.(total);
    else navigator.clearAppBadge?.();
  } catch {}
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

function formatLastSeen(ts) {
  if (!ts) return 'не в сети';
  const d = new Date(ts * 1000);
  const diffSec = Math.floor((Date.now() - ts * 1000) / 1000);
  if (diffSec < 60) return 'только что';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `был(а) в сети ${diffMin} мин. назад`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `был(а) в сети ${diffH} ч. назад`;
  const time = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  const today = new Date(); today.setHours(0,0,0,0);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const msgDay = new Date(d); msgDay.setHours(0,0,0,0);
  if (msgDay.getTime() === today.getTime()) return `был(а) в сети сегодня в ${time}`;
  if (msgDay.getTime() === yesterday.getTime()) return `был(а) в сети вчера в ${time}`;
  const diffDays = Math.floor((today - msgDay) / 86400000);
  if (diffDays < 7) {
    const days = ['воскресенье','понедельник','вторник','среду','четверг','пятницу','субботу'];
    return `был(а) в сети в ${days[d.getDay()]} в ${time}`;
  }
  return `был(а) в сети ${d.toLocaleDateString('ru', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

function peerStatusText(userId) {
  const st = S.presence[userId] || 'offline';
  if (st === 'online') return 'в сети';
  return formatLastSeen(S.lastSeen[userId]);
}

// Периодически обновляем "был(а) в сети N мин. назад" в шапке открытого личного чата,
// иначе таймштамп замирает и остаётся "только что" сколько бы времени ни прошло.
setInterval(() => {
  if (!S.activeChatId) return;
  const chat = S.chats.find(c => c.id === S.activeChatId);
  if (!chat || chat.type !== 'direct') return;
  const peerId = getPeerUserId(chat);
  if (!peerId) return;
  const subEl = document.querySelector('.ch-sub');
  if (subEl) subEl.textContent = peerStatusText(peerId);
}, 30000);

function presenceDot(userId) {
  // Элемент рендерим всегда (скрытым если офлайн) — иначе WS-хендлеру presence
  // нечего показывать, когда пользователь появляется в сети.
  const online = (S.presence[userId] || 'offline') === 'online';
  return `<span class="presence-dot" data-user-id="${userId}"${online ? '' : ' style="display:none"'}></span>`;
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
// Мини-аватар для списков выбора: инициалы + фото поверх если есть
function ppAvHtml(u) {
  return `<div class="pp-av ${avatarColor(u.id)}"><span>${initials(u.display_name)}</span><img src="${httpProto()}://${S.server}/api/users/${u.id}/avatar" loading="lazy" onerror="this.style.display='none'"></div>`;
}
const PP_CHECK = `<span class="pp-check"><svg width="10" height="10" fill="none" stroke="currentColor" stroke-width="3.5" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></span>`;

function openNewChat() {
  S.ncSelected = new Set();
  S.newGroupAvatarBase64 = null;
  setChatMainContent(`
    <div class="gi-panel nc-panel">
      <div class="gi-top-bar">
        <button class="icon-btn" onclick="closeNewChat()" title="Закрыть">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span class="gi-top-title" id="nc-title">Новый чат</span>
      </div>
      <div class="nc-panel-body">
        <div class="nc-panel-tabs">
          <div class="nc-tabs">
            <button class="nc-tab active" id="nc-btn-direct" onclick="switchTab('direct')">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              Личный
            </button>
            <button class="nc-tab" id="nc-btn-group" onclick="switchTab('group')">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 1-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              Группа
            </button>
          </div>
        </div>
        <div id="nc-group-settings" style="display:none" class="nc-panel-group-settings">
          <div class="nc-group-top">
            <div class="av av-md av-sq av-green" id="new-group-av" style="cursor:pointer;flex-shrink:0" onclick="triggerGroupAvatarUpload()">G</div>
            <input id="group-name" class="nc-name-input" placeholder="Название группы">
          </div>
          <input type="file" id="group-avatar-input" accept="image/*" style="display:none" onchange="onGroupAvatarChange(this)">
        </div>
        <div class="nc-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input id="nc-search-input" placeholder="Поиск..." oninput="filterModalUsers(this.value,'tab-direct');filterModalUsers(this.value,'tab-group')">
        </div>
        <div class="nc-panel-lists">
          <div id="tab-direct" class="users-list nc-list"></div>
          <div id="tab-group" class="users-list nc-list" style="display:none"></div>
        </div>
      </div>
      <div id="nc-footer" style="display:none" class="gi-footer">
        <button class="modal-btn-ghost" onclick="closeNewChat()">Отмена</button>
        <button class="modal-btn-primary" onclick="createGroup()">Создать группу</button>
      </div>
    </div>`);
  renderModalUsers('tab-direct', false);
  renderModalUsers('tab-group', true);
  openMobileChat();
}

function closeNewChat() {
  const go = () => {
    if (S.activeChatId) openChat(S.activeChatId);
    else if (_isMobile()) {
      document.getElementById('chat-main')?.classList.remove('mobile-open');
      document.querySelector('.sidebar')?.classList.remove('mobile-hidden');
    } else {
      setChatMainContent(`<div class="empty-state"><div class="empty-icon">💬</div><div class="empty-title">Чат</div><div class="empty-sub">Выберите чат или создайте новый</div></div>`);
    }
  };
  const panel = document.querySelector('.gi-panel');
  if (panel) { panel.classList.add('gi-closing'); setTimeout(go, 150); }
  else go();
}

function renderModalUsers(containerId, multi, filter='') {
  const container = document.getElementById(containerId);
  if (!container) return;
  const list = S.allUsers.filter(u=>!filter||u.display_name.toLowerCase().includes(filter)||u.username.toLowerCase().includes(filter));
  container.innerHTML = list.map(u=>`
    <div class="pp-row${multi&&S.ncSelected?.has(u.id)?' on':''}" data-uid="${u.id}" onclick="${multi?`toggleModalUser(${u.id})`:`startDirect(${u.id})`}">
      ${ppAvHtml(u)}
      <span class="pp-name">${esc(u.display_name)}</span>
      ${u.tag?`<span class="pp-tag">${esc(u.tag)}</span>`:''}
      ${multi?PP_CHECK:''}
    </div>`).join('') || '<div class="pp-empty">Нет пользователей</div>';
}

function filterModalUsers(q, containerId) {
  const multi = containerId==='tab-group';
  const el = document.getElementById(containerId);
  if (el?.style.display==='none') return;
  renderModalUsers(containerId, multi, q.toLowerCase());
}

function toggleModalUser(id) {
  if (!S.ncSelected) S.ncSelected = new Set();
  if (S.ncSelected.has(id)) S.ncSelected.delete(id);
  else S.ncSelected.add(id);
  const q = (document.getElementById('nc-search-input')?.value || '').toLowerCase();
  renderModalUsers('tab-group', true, q);
}

async function startDirect(userId) {
  const data = await api('POST','/chats/direct',{user_id:userId});
  if (data?.id) { await loadChats(); openChat(data.id); }
}

async function createGroup() {
  const name = document.getElementById('group-name').value.trim();
  if (!name) { document.getElementById('group-name').focus(); return; }
  const selected = [...(S.ncSelected || [])];
  const data = await api('POST','/chats/group',{name, member_ids:selected});
  if (data?.id) {
    if (S.newGroupAvatarBase64) {
      await api('POST', `/chats/${data.id}/avatar`, { data: S.newGroupAvatarBase64 });
      S.newGroupAvatarBase64 = null;
    }
    await loadChats(); openChat(data.id);
  }
}

function switchTab(tab) {
  document.querySelectorAll('.nc-type-btn,.nc-tab').forEach(b => b.classList.remove('active'));
  document.getElementById(`nc-btn-${tab}`)?.classList.add('active');
  document.getElementById('tab-direct').style.display = tab==='direct' ? 'flex' : 'none';
  document.getElementById('tab-group').style.display = tab==='group' ? 'flex' : 'none';
  document.getElementById('nc-group-settings').style.display = tab==='group' ? '' : 'none';
  document.getElementById('nc-footer').style.display = tab==='group' ? '' : 'none';
  document.getElementById('nc-title').textContent = tab==='direct' ? 'Новый чат' : 'Новая группа';
}

// ── GROUP INFO PANEL ──
async function openGroupInfo(chatId) {
  S.giChatId = chatId;
  S.giRemovedIds = new Set();
  S.giAddIds = new Set();
  S.giAvatarBase64 = null;
  const chat = S.chats.find(c => c.id === chatId);
  const isRoom = chat?.type === 'room';
  const canEdit = isRoom ? S.user.is_admin : (chat.created_by === S.user.id || S.user.is_admin);
  const canDelete = !isRoom && (chat.created_by === S.user.id || S.user.is_admin);
  const leaveBtn = !isRoom ? `<button class="gi-btn gi-btn-leave" onclick="giLeave()">Выйти</button>` : '';
  const deleteBtn = canDelete ? `<button class="gi-btn gi-btn-delete" onclick="giDelete()">Удалить</button>` : '';
  const addBtn = canEdit ? `<button class="gi-btn gi-btn-add" onclick="giShowAdd()">Добавить участника</button>` : '';
  setChatMainContent(`
    <div class="gi-panel">
      <div class="gi-top-bar">
        <button class="icon-btn" onclick="closeGroupInfo()" title="Закрыть">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span class="gi-top-title">${isRoom ? 'Комната' : 'Группа'}</span>
      </div>
      <div class="gi-body">
        <div class="gi-avatar-wrap">
          <div class="av av-sq ${avatarColor(chatId)}" id="gi-av" style="width:80px;height:80px;font-size:24px;font-weight:700;${canEdit?'cursor:pointer':''}" ${canEdit?'onclick="triggerGiAvatarUpload()"':''}>${initials(chat?.name||'G')}</div>
          ${canEdit?`<div class="gi-avatar-badge" onclick="triggerGiAvatarUpload()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></div>`:''}
        </div>
        <input type="file" id="gi-avatar-input" accept="image/*" style="display:none" onchange="onGiAvatarChange(this)">
        <div class="gi-name-wrap">
          <input id="gi-name" class="gi-name-input" value="${esc(chat?.name||'')}" placeholder="Название" ${canEdit?'':'readonly'}>
        </div>
        <div class="gi-actions">
          ${addBtn}
          ${leaveBtn}
          ${deleteBtn}
        </div>
        <div class="gi-section-title">Участники</div>
        <div class="gi-members-list" id="gi-members"></div>
      </div>
      ${canEdit?`<div class="gi-footer"><button class="modal-btn-ghost" onclick="closeGroupInfo()">Отмена</button><button class="modal-btn-primary" onclick="saveGroupEdit()">Сохранить</button></div>`:''}
    </div>`);
  const av = document.getElementById('gi-av');
  const avatarUrl = `${httpProto()}://${S.server}/api/chats/${chatId}/avatar?t=${Date.now()}`;
  const img = new Image();
  img.onload = () => { av.style.backgroundImage = `url('${avatarUrl}')`; av.style.backgroundSize = 'cover'; av.textContent = ''; };
  img.src = avatarUrl;
  giRenderMembers(chat?.members || [], canEdit);
}

function closeGroupInfo() {
  const panel = document.querySelector('.gi-panel');
  if (panel) { panel.classList.add('gi-closing'); setTimeout(() => openChat(S.giChatId), 150); }
  else openChat(S.giChatId);
}

function giRenderMembers(members, canEdit = false) {
  const container = document.getElementById('gi-members');
  if (!container) return;
  container.innerHTML = members
    .filter(m => m.id !== S.user.id && !S.giRemovedIds.has(m.id))
    .map(m => `
      <div class="member-remove-row" id="gim-${m.id}">
        <div class="av av-sm av-round ${avatarColor(m.id)}" data-av-user="${m.id}">${initials(m.display_name)}</div>
        <div class="info"><div class="rname">${esc(m.display_name)}</div><div class="rlogin">@${esc(m.username)}</div></div>
        ${canEdit?`<button class="rm-btn" onclick="giRemoveMember(${m.id})">✕</button>`:''}
      </div>`).join('') || '<div style="font-size:13px;color:var(--muted)">Только вы</div>';
  applyAvatars();
}

async function giRemoveMember(id) {
  const ok = await showConfirm('Удалить участника из группы?', 'Удалить');
  if (!ok) return;
  S.giRemovedIds.add(id);
  document.getElementById(`gim-${id}`)?.remove();
}

async function giLeave() { await leaveGroup(S.giChatId); }
async function giDelete() { await deleteChat(S.giChatId); }

function giBackToInfo() {
  const panel = document.querySelector('.gi-panel');
  if (panel) { panel.classList.add('gi-closing'); setTimeout(() => openGroupInfo(S.giChatId), 150); }
  else openGroupInfo(S.giChatId);
}

async function giShowAdd() {
  const chat = S.chats.find(c => c.id === S.giChatId);
  const render = () => {
    setChatMainContent(`
    <div class="gi-panel">
      <div class="gi-top-bar">
        <button class="icon-btn" onclick="giBackToInfo()" title="Назад">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span class="gi-top-title">Добавить участника</span>
      </div>
      <div class="gi-body">
        <div class="gi-add-list" id="gi-add-list"></div>
      </div>
      <div class="gi-footer">
        <button class="modal-btn-ghost" onclick="giBackToInfo()">Отмена</button>
        <button class="modal-btn-primary" onclick="giConfirmAdd()">Добавить</button>
      </div>
    </div>`);
    giRenderAddList(chat?.members || []);
  };
  const panel = document.querySelector('.gi-panel');
  if (panel) { panel.classList.add('gi-closing'); setTimeout(render, 150); }
  else render();
}

function giRenderAddList(existingMembers) {
  const existingIds = new Set(existingMembers.map(m => m.id));
  const container = document.getElementById('gi-add-list');
  if (!container) return;
  const available = S.allUsers.filter(u => !existingIds.has(u.id) || S.giRemovedIds.has(u.id));
  container.innerHTML = available.map(u => `
    <div class="user-row${S.giAddIds.has(u.id) ? ' selected' : ''}" data-uid="${u.id}" onclick="giToggleAdd(this,${u.id})">
      <div class="av av-sm av-round ${avatarColor(u.id)}" data-av-user="${u.id}">${initials(u.display_name)}</div>
      <div><div class="uname">${esc(u.display_name)}</div><div class="ulogin">@${esc(u.username)}</div></div>
    </div>`).join('') || '<div style="font-size:13px;color:var(--muted)">Нет доступных</div>';
  applyAvatars();
}

function giToggleAdd(el, id) {
  el.classList.toggle('selected');
  S.giAddIds.has(id) ? S.giAddIds.delete(id) : S.giAddIds.add(id);
}

async function giConfirmAdd() {
  const chatId = S.giChatId;
  await Promise.all([...S.giAddIds].map(uid => api('POST', `/chats/${chatId}/members`, {user_id: uid})));
  S.giAddIds = new Set();
  await loadChats();
  giBackToInfo();
}

function triggerGiAvatarUpload() { document.getElementById('gi-avatar-input').click(); }
function onGiAvatarChange(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    S.giAvatarBase64 = e.target.result.split(',')[1];
    const el = document.getElementById('gi-av');
    el.style.backgroundImage = `url('${e.target.result}')`;
    el.style.backgroundSize = 'cover'; el.textContent = '';
  };
  reader.readAsDataURL(file);
}

async function saveGroupEdit() {
  const name = document.getElementById('gi-name').value.trim();
  const chatId = S.giChatId;
  const ops = [
    name && api('PATCH', `/chats/${chatId}`, {name}),
    ...[...S.giRemovedIds].map(uid => api('DELETE', `/chats/${chatId}/members/${uid}`)),
    ...[...S.giAddIds].map(uid => api('POST', `/chats/${chatId}/members`, {user_id: uid})),
  ];
  if (S.giAvatarBase64) ops.push(api('POST', `/chats/${chatId}/avatar`, {data: S.giAvatarBase64}));
  await Promise.all(ops);
  S.giAvatarBase64 = null;
  await loadChats();
  openChat(chatId);
}

// ── CHAT LIST CONTEXT MENU ──
function showChatCtx(e, chatId) {
  e.preventDefault();
  e.stopPropagation();
  const chat = S.chats.find(c => c.id === chatId);
  // Комнатами управляет только админ через админку — в клиенте меню нет
  if (chat?.type === 'room') return;
  S.ctxChatId = chatId;
  const menu = document.getElementById('ctx-chat-menu');
  const pinLabel = document.getElementById('ctx-chat-pin-label');
  if (pinLabel) pinLabel.textContent = chat?.pinned ? 'Открепить' : 'Закрепить';
  // Группа: создатель/админ — удаляет, иначе — выходит
  const isGroup = chat?.type === 'group';
  const canDelete = !isGroup || chat.created_by === S.user.id || S.user.is_admin;
  const delBtn = document.getElementById('ctx-chat-delete');
  const leaveBtn = document.getElementById('ctx-chat-leave');
  if (delBtn) delBtn.style.display = canDelete ? '' : 'none';
  if (leaveBtn) leaveBtn.style.display = (isGroup && !canDelete) ? '' : 'none';
  menu.style.top = '-9999px'; menu.style.left = '-9999px';
  menu.style.display = 'block';
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const margin = 6;
  const _z = (S.settings.uiScale || 100) / 100;
  let x = e.clientX / _z, y = e.clientY / _z;
  if (x + mw + margin > window.innerWidth) x = window.innerWidth - mw - margin;
  if (y + mh + margin > window.innerHeight) y = e.clientY / _z - mh;
  if (y < margin) y = margin;
  if (x < margin) x = margin;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

async function ctxChatLeave() {
  document.getElementById('ctx-chat-menu').style.display = 'none';
  if (!S.ctxChatId) return;
  await leaveGroup(S.ctxChatId);
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

// ── CHAT ACTION SHEET (mobile bottom sheet) ──
function openChatSheet(chatId) {
  S.ctxChatId = chatId;
  const chat = S.chats.find(c => c.id === chatId);
  document.getElementById('chat-sheet-title').textContent = chat ? chatName(chat) : '';
  const pinLabel = document.getElementById('sheet-pin-label');
  if (pinLabel) pinLabel.textContent = chat?.pinned ? 'Открепить' : 'Закрепить';
  const pinBtn = document.getElementById('sheet-pin-btn');
  if (pinBtn) pinBtn.style.display = chat?.type === 'room' ? 'none' : '';
  document.getElementById('chat-sheet-backdrop').classList.add('open');
  document.getElementById('chat-action-sheet').classList.add('open');
}
function closeChatSheet() {
  document.getElementById('chat-sheet-backdrop').classList.remove('open');
  document.getElementById('chat-action-sheet').classList.remove('open');
}
async function sheetPinChat() {
  closeChatSheet();
  if (!S.ctxChatId) return;
  await api('POST', `/chats/${S.ctxChatId}/pin`);
  await loadChats();
}

async function sheetDeleteChat() {
  closeChatSheet();
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
