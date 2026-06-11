'use strict';

const CACHE = 'corp-chat-v2';
const STATIC = ['/chat/', '/chat/app.js', '/chat/style.css', '/chat/manifest.json', '/chat/icons/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Не перехватываем API, WebSocket и запросы к другим хостам
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(e.request)
      .then(r => {
        // Обновляем кэш свежим ответом
        if (r.ok) {
          const clone = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});

// ── PUSH NOTIFICATIONS ──
self.addEventListener('push', e => {
  const data = e.data?.json?.() || {};
  const title = data.title || 'Новое сообщение';
  const options = {
    body: data.body || '',
    icon: '/chat/icons/icon.svg',
    badge: '/chat/icons/icon.svg',
    tag: data.chatId ? `chat-${data.chatId}` : 'msg',
    renotify: true,
    data: { chatId: data.chatId },
  };
  const tasks = [self.registration.showNotification(title, options)];
  // Счётчик на иконке PWA (когда приложение закрыто)
  if (typeof data.unread === 'number' && self.navigator.setAppBadge) {
    tasks.push(data.unread > 0 ? self.navigator.setAppBadge(data.unread) : self.navigator.clearAppBadge());
  } else if (self.navigator.setAppBadge) {
    tasks.push(self.navigator.setAppBadge());
  }
  e.waitUntil(Promise.all(tasks).catch(() => {}));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const chatId = e.notification.data?.chatId;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.visibilityState === 'visible') || list[0];
      if (existing) {
        existing.focus();
        if (chatId) existing.postMessage({ type: 'open-chat', chatId });
      } else {
        clients.openWindow(chatId ? `/chat/?chatId=${chatId}` : '/chat/');
      }
    })
  );
});
