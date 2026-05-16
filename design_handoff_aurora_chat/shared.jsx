// Shared data + helpers for all chat variants

const ME = {
  id: 'me',
  name: 'Иван Болгов',
  username: 'bolgov',
  initial: 'И',
  color: '#7c8aa1',
};

const PEERS = {
  test: { id: 'test', name: 'Тестовый Тест', username: 'test', initial: 'Т', color: '#f59e0b', kind: 'bot' },
  devops: { id: 'devops', name: 'DevOps', username: 'linux', initial: 'D', color: '#10b981', online: true },
  admin: { id: 'admin', name: 'Administrator', username: 'admin', initial: 'A', color: '#22c55e' },
  alex: { id: 'alex', name: 'Алекс Кузнецов', username: 'akuznetsov', initial: 'А', color: '#a855f7', online: true },
  marina: { id: 'marina', name: 'Марина Лебедева', username: 'mlebedeva', initial: 'М', color: '#ec4899' },
  ci: { id: 'ci', name: 'CI / Деплой', username: 'ci_bot', initial: 'C', color: '#0ea5e9', kind: 'bot' },
};

const CHATS = [
  {
    id: 'test',
    peer: PEERS.test,
    last: 'и график',
    time: '13:42',
    unread: 0,
    pinned: true,
    messages: [
      { from: 'me', text: 'https://ya.ru', time: '16:29', read: true },
      { from: 'me', text: ')))', time: '16:33', read: true, reply: { from: 'me', text: ')))', name: 'Иван Болгов' } },
      { from: 'me', text: 'вот так вот', time: '16:33', read: true },
      { from: 'me', text: 'привет', time: '16:46', read: true },
      { from: 'me', text: 'потому что у нас много текста', time: '16:47', read: true },
      { day: 'Сегодня' },
      { from: 'me', text: 'привет!', time: '13:18', read: true },
      { from: 'test', text: 'Привет!', time: '13:41' },
      { from: 'test', text: 'Проверяем сообщения', time: '13:41' },
      { from: 'test', text: 'и график', time: '13:42' },
    ],
  },
  {
    id: 'devops',
    peer: PEERS.devops,
    last: 'привет!',
    time: '15:00',
    unread: 2,
    messages: [
      { from: 'devops', text: 'Сервер node-3 ушёл в свап, посмотри плз', time: '14:55' },
      { from: 'devops', text: 'привет!', time: '15:00' },
    ],
  },
  {
    id: 'alex',
    peer: PEERS.alex,
    last: 'Релиз завтра в 11:00 по плану',
    time: '14:12',
    unread: 0,
    messages: [
      { from: 'alex', text: 'Готов к ревью?', time: '13:50' },
      { from: 'me', text: 'Да, смотрю', time: '13:52', read: true },
      { from: 'alex', text: 'Релиз завтра в 11:00 по плану', time: '14:12' },
    ],
  },
  {
    id: 'marina',
    peer: PEERS.marina,
    last: 'отправила макет, посмотри',
    time: 'вчера',
    unread: 0,
    messages: [
      { from: 'marina', text: 'отправила макет, посмотри', time: '18:34' },
    ],
  },
  {
    id: 'ci',
    peer: PEERS.ci,
    last: 'Build #2148 — success',
    time: '11:08',
    unread: 0,
    messages: [
      { from: 'ci', text: 'Build #2148 — success ✓', time: '11:08' },
    ],
  },
];

// SVG icons (compact, monoline)
const Icons = {
  Search: (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/></svg>,
  Settings: (p) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  Compose: (p) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>,
  Trash: (p) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>,
  Send: (p) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>,
  Smile: (p) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>,
  Check: (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...p}><polyline points="20 6 9 17 4 12"/></svg>,
  DoubleCheck: (p) => <svg width="16" height="14" viewBox="0 0 24 18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...p}><polyline points="1 10 6 15 14 4"/><polyline points="9 15 17 4"/><polyline points="13 15 23 4"/></svg>,
  Close: (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M18 6 6 18M6 6l12 12"/></svg>,
  Plus: (p) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 5v14M5 12h14"/></svg>,
  User: (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
  Users: (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  Sun: (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>,
  Moon: (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>,
  Refresh: (p) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>,
  Reply: (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>,
  Copy: (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>,
  Info: (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>,
  Pin: (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>,
  Paperclip: (p) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.83l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>,
  Mic: (p) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>,
};

// Simple avatar component — colored square with initial
function Avatar({ peer, size = 36, radius = 10, ring }) {
  const fontSize = Math.round(size * 0.42);
  return (
    <div style={{
      width: size, height: size, borderRadius: radius,
      background: peer.color,
      color: '#fff',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontWeight: 600, fontSize, flexShrink: 0,
      boxShadow: ring ? `0 0 0 2px ${ring}` : 'none',
      position: 'relative',
    }}>
      {peer.initial}
      {peer.online && (
        <span style={{
          position: 'absolute', bottom: -1, right: -1,
          width: size * 0.3, height: size * 0.3, borderRadius: '50%',
          background: '#22c55e', boxShadow: `0 0 0 2px ${ring || '#0b0c10'}`,
        }}/>
      )}
    </div>
  );
}

Object.assign(window, { ME, PEERS, CHATS, Icons, Avatar });
