// V1 · Aurora — Soft modern messenger
// Plump bubbles, indigo accent, friendly density, both themes.

function ChatV1({ initialTheme = 'dark', initialView = 'bubbles' }) {
  const [theme, setTheme] = React.useState(initialTheme);
  const [view, setView] = React.useState(initialView); // 'bubbles' | 'irc'
  const [activeId, setActiveId] = React.useState('test');
  const [modal, setModal] = React.useState(null); // 'settings' | 'new' | 'info' | 'update'
  const [ctxMenu, setCtxMenu] = React.useState(null); // msg index
  const [draft, setDraft] = React.useState('');
  const [replyTo, setReplyTo] = React.useState(null);

  const t = theme === 'dark' ? V1.dark : V1.light;
  const chat = CHATS.find(c => c.id === activeId);

  const scrollRef = React.useRef();
  React.useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [activeId, replyTo]);

  return (
    <div style={{
      width: '100%', height: '100%', display: 'flex',
      background: t.appBg, color: t.text,
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', 'SF Pro Text', system-ui, sans-serif",
      fontSize: 14, position: 'relative', overflow: 'hidden',
      transition: 'background .25s, color .25s',
    }}>
      {/* Decorative gradient blobs */}
      <div style={{ position: 'absolute', top: -120, left: -80, width: 360, height: 360,
        background: `radial-gradient(circle, ${t.blob1} 0%, transparent 65%)`,
        pointerEvents: 'none', filter: 'blur(20px)' }}/>
      <div style={{ position: 'absolute', bottom: -160, right: -120, width: 420, height: 420,
        background: `radial-gradient(circle, ${t.blob2} 0%, transparent 65%)`,
        pointerEvents: 'none', filter: 'blur(20px)' }}/>

      {/* SIDEBAR */}
      <aside style={{
        width: 296, flexShrink: 0, display: 'flex', flexDirection: 'column',
        background: t.sideBg, borderRight: `1px solid ${t.border}`,
        backdropFilter: 'blur(20px)', position: 'relative', zIndex: 1,
      }}>
        <div style={{ padding: '14px 14px 10px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Avatar peer={{ ...ME, color: t.accent }} size={36} radius={12} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{ME.name}</div>
            <div style={{ fontSize: 12, color: t.muted, display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e' }}/>
              онлайн
            </div>
          </div>
          <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} style={iconBtn(t)} title="Тема">
            {theme === 'dark' ? <Icons.Sun/> : <Icons.Moon/>}
          </button>
          <button onClick={() => setModal('settings')} style={iconBtn(t)} title="Настройки"><Icons.Settings/></button>
          <button onClick={() => setModal('new')} style={iconBtn(t)} title="Новый чат"><Icons.Compose/></button>
        </div>

        <div style={{ padding: '4px 14px 12px' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: t.searchBg, borderRadius: 12, padding: '9px 12px',
            border: `1px solid ${t.border}`,
          }}>
            <span style={{ color: t.muted }}><Icons.Search/></span>
            <input placeholder="Поиск" style={{
              background: 'transparent', border: 'none', outline: 'none', color: t.text,
              fontSize: 14, flex: 1, fontFamily: 'inherit',
            }}/>
            <kbd style={{
              fontSize: 11, color: t.muted, padding: '2px 6px',
              border: `1px solid ${t.border}`, borderRadius: 5, fontFamily: 'inherit',
            }}>⌘K</kbd>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 12px' }}>
          <div style={{ padding: '8px 8px 6px', fontSize: 11, fontWeight: 600,
            letterSpacing: '0.06em', textTransform: 'uppercase', color: t.muted }}>
            Закреплённые
          </div>
          {CHATS.filter(c => c.pinned).map(c => (
            <V1ChatRow key={c.id} chat={c} active={c.id === activeId} t={t} onClick={() => setActiveId(c.id)} pinned />
          ))}
          <div style={{ padding: '12px 8px 6px', fontSize: 11, fontWeight: 600,
            letterSpacing: '0.06em', textTransform: 'uppercase', color: t.muted }}>
            Все чаты
          </div>
          {CHATS.filter(c => !c.pinned).map(c => (
            <V1ChatRow key={c.id} chat={c} active={c.id === activeId} t={t} onClick={() => setActiveId(c.id)} />
          ))}
        </div>
      </aside>

      {/* MAIN */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 1 }}>
        {/* HEADER */}
        <header style={{
          height: 64, flexShrink: 0, padding: '0 20px',
          display: 'flex', alignItems: 'center', gap: 12,
          borderBottom: `1px solid ${t.border}`, background: t.headerBg,
          backdropFilter: 'blur(12px)',
        }}>
          <Avatar peer={chat.peer} size={40} radius={12} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontWeight: 600, fontSize: 15 }}>{chat.peer.name}</span>
              {chat.peer.kind === 'bot' && (
                <span style={{
                  fontSize: 10, padding: '1px 6px', borderRadius: 4,
                  background: t.accentSoft, color: t.accent, fontWeight: 600,
                  letterSpacing: '0.04em',
                }}>BOT</span>
              )}
            </div>
            <div style={{ fontSize: 12, color: t.muted }}>
              {chat.peer.online ? 'в сети' : 'был(а) недавно · Личный чат'}
            </div>
          </div>
          <button style={iconBtn(t, view === 'irc' ? t.accent : undefined)}
            onClick={() => setView(view === 'irc' ? 'bubbles' : 'irc')}
            title={view === 'irc' ? 'Переключить на пузыри' : 'Переключить на IRC'}>
            {view === 'irc'
              ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
              : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>}
          </button>
          <button style={iconBtn(t)} onClick={() => setModal('update')} title="Обновление"><Icons.Refresh/></button>
          <button style={iconBtn(t)} onClick={() => setModal('info')} title="Инфо"><Icons.Info/></button>
          <button style={iconBtn(t, '#ef4444')} title="Очистить"><Icons.Trash/></button>
        </header>

        {/* MESSAGES */}
        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '20px 24px 12px' }}>
          <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {chat.messages.map((m, i) => {
              if (m.day) return (
                <div key={i} style={{ alignSelf: 'center', margin: '12px 0', padding: '4px 12px',
                  background: t.daypill, color: t.muted, borderRadius: 999, fontSize: 12,
                  border: `1px solid ${t.border}` }}>
                  {m.day}
                </div>
              );
              const mine = m.from === 'me';
              const prev = chat.messages[i - 1];
              const grouped = prev && !prev.day && prev.from === m.from;
              return (
                view === 'irc' ? (
                  <V1MessageIRC key={i} m={m} mine={mine} grouped={grouped} t={t} peer={chat.peer}
                    onCtx={() => setCtxMenu(ctxMenu === i ? null : i)}
                    ctxOpen={ctxMenu === i}
                    onReply={() => { setReplyTo(m); setCtxMenu(null); }}
                    onInfo={() => { setModal('info'); setCtxMenu(null); }}/>
                ) : (
                  <V1Message key={i} m={m} mine={mine} grouped={grouped} t={t}
                    onCtx={() => setCtxMenu(ctxMenu === i ? null : i)}
                    ctxOpen={ctxMenu === i}
                    onReply={() => { setReplyTo(m); setCtxMenu(null); }}
                    onInfo={() => { setModal('info'); setCtxMenu(null); }}
                    peer={chat.peer}/>
                )
              );
            })}
          </div>
        </div>

        {/* COMPOSER */}
        <div style={{ padding: '12px 24px 18px' }}>
          <div style={{ maxWidth: 760, margin: '0 auto' }}>
            {replyTo && (
              <div style={{
                background: t.replyBg, borderLeft: `3px solid ${t.accent}`,
                padding: '8px 10px 8px 12px', borderRadius: '10px 10px 4px 4px',
                display: 'flex', alignItems: 'flex-start', gap: 10,
                marginBottom: -2,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: t.accent }}>
                    {replyTo.from === 'me' ? ME.name : chat.peer.name}
                  </div>
                  <div style={{ fontSize: 13, color: t.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {replyTo.text}
                  </div>
                </div>
                <button onClick={() => setReplyTo(null)} style={iconBtn(t)}><Icons.Close/></button>
              </div>
            )}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              background: t.composerBg, borderRadius: replyTo ? '4px 4px 18px 18px' : 18,
              padding: '8px 8px 8px 14px', border: `1px solid ${t.border}`,
            }}>
              <button style={iconBtn(t)} title="Файл"><Icons.Paperclip/></button>
              <button style={iconBtn(t)} title="Эмодзи"><Icons.Smile/></button>
              <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="Сообщение..." style={{
                flex: 1, background: 'transparent', border: 'none', outline: 'none',
                color: t.text, fontSize: 14, padding: '8px 4px', fontFamily: 'inherit',
              }}/>
              {draft ? (
                <button style={{
                  width: 38, height: 38, borderRadius: 12, border: 'none', cursor: 'pointer',
                  background: t.accent, color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: `0 6px 16px ${t.accentShadow}`,
                }} title="Отправить" onClick={() => { setDraft(''); setReplyTo(null); }}><Icons.Send/></button>
              ) : (
                <button style={iconBtn(t)} title="Голос"><Icons.Mic/></button>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* MODALS */}
      {modal === 'settings' && <V1Settings t={t} theme={theme} setTheme={setTheme} view={view} setView={setView} onClose={() => setModal(null)} />}
      {modal === 'new' && <V1NewChat t={t} onClose={() => setModal(null)} />}
      {modal === 'info' && <V1Info t={t} onClose={() => setModal(null)} />}
      {modal === 'update' && <V1Update t={t} onClose={() => setModal(null)} />}
    </div>
  );
}

function V1ChatRow({ chat, active, t, onClick, pinned }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 12, width: '100%',
      padding: '10px 10px', borderRadius: 12, border: 'none',
      background: active ? t.activeRow : 'transparent', cursor: 'pointer',
      textAlign: 'left', color: 'inherit', marginBottom: 2,
      transition: 'background .12s',
      position: 'relative',
    }}
    onMouseEnter={e => !active && (e.currentTarget.style.background = t.hoverRow)}
    onMouseLeave={e => !active && (e.currentTarget.style.background = 'transparent')}>
      {active && <span style={{
        position: 'absolute', left: -8, top: '50%', transform: 'translateY(-50%)',
        width: 3, height: 24, borderRadius: 2, background: t.accent,
      }}/>}
      <Avatar peer={chat.peer} size={40} radius={12} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontWeight: 600, fontSize: 14, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {chat.peer.name}
          </span>
          {pinned && <span style={{ color: t.muted, opacity: 0.7 }}><Icons.Pin/></span>}
          <span style={{ fontSize: 11, color: t.muted, flexShrink: 0 }}>{chat.time}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
          <span style={{ flex: 1, fontSize: 13, color: t.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {chat.last}
          </span>
          {chat.unread > 0 && (
            <span style={{
              minWidth: 18, height: 18, padding: '0 6px', borderRadius: 9,
              background: t.accent, color: '#fff', fontSize: 11, fontWeight: 600,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{chat.unread}</span>
          )}
        </div>
      </div>
    </button>
  );
}

function V1Message({ m, mine, grouped, t, onCtx, ctxOpen, onReply, onInfo, peer }) {
  const author = mine ? ME : peer;
  return (
    <div style={{
      display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start',
      marginTop: grouped ? -4 : 0, position: 'relative',
    }}>
      {!mine && (
        <div style={{ width: 32, marginRight: 8, flexShrink: 0 }}>
          {!grouped && <Avatar peer={author} size={32} radius={10} />}
        </div>
      )}
      <div style={{
        maxWidth: '70%', display: 'flex', flexDirection: 'column',
        alignItems: mine ? 'flex-end' : 'flex-start',
      }}>
        {!grouped && !mine && (
          <div style={{ fontSize: 12, color: t.muted, fontWeight: 600, marginBottom: 4, marginLeft: 4 }}>
            {author.name}
          </div>
        )}
        <div onClick={onCtx} style={{
          background: mine ? t.bubbleMine : t.bubbleOther,
          color: mine ? '#fff' : t.text,
          padding: '8px 12px 6px',
          borderRadius: 16,
          borderTopRightRadius: mine && grouped ? 8 : (mine ? 16 : 16),
          borderBottomRightRadius: mine ? 6 : 16,
          borderTopLeftRadius: !mine && grouped ? 8 : 16,
          borderBottomLeftRadius: !mine ? 6 : 16,
          fontSize: 14, lineHeight: 1.45,
          boxShadow: mine ? `0 4px 14px ${t.accentShadow}` : t.bubbleShadow,
          cursor: 'pointer', position: 'relative',
          wordBreak: 'break-word',
        }}>
          {m.reply && (
            <div style={{
              borderLeft: `3px solid ${mine ? 'rgba(255,255,255,.55)' : t.accent}`,
              padding: '4px 8px', marginBottom: 6, borderRadius: 6,
              background: mine ? 'rgba(255,255,255,.12)' : t.replyBg,
            }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: mine ? 'rgba(255,255,255,.9)' : t.accent }}>
                {m.reply.name}
              </div>
              <div style={{ fontSize: 12, opacity: 0.8 }}>{m.reply.text}</div>
            </div>
          )}
          <div>{m.text}</div>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 8,
            fontSize: 11, color: mine ? 'rgba(255,255,255,.75)' : t.muted, float: 'right',
            marginTop: 2,
          }}>
            <span>{m.time}</span>
            {mine && (m.read
              ? <span style={{ color: '#a5f3fc' }}><Icons.DoubleCheck/></span>
              : <Icons.Check/>)}
          </div>
        </div>
        {ctxOpen && <V1CtxMenu t={t} onReply={onReply} onInfo={onInfo} mine={mine}/>}
      </div>
    </div>
  );
}

function V1MessageIRC({ m, mine, grouped, t, peer, onCtx, ctxOpen, onReply, onInfo }) {
  const author = mine ? ME : peer;
  const nameColor = mine ? t.accent : author.color;
  return (
    <div onMouseEnter={e => e.currentTarget.querySelector('[data-irc-actions]').style.opacity = 1}
         onMouseLeave={e => e.currentTarget.querySelector('[data-irc-actions]').style.opacity = 0}
         style={{
      padding: grouped ? '1px 0' : '6px 0 1px',
      position: 'relative', display: 'flex', gap: 12,
      borderRadius: 6, paddingLeft: 8, paddingRight: 8, marginLeft: -8, marginRight: -8,
      transition: 'background .12s',
    }}>
      <div style={{ width: 28, flexShrink: 0, paddingTop: grouped ? 4 : 6 }}>
        {!grouped
          ? <Avatar peer={author} size={28} radius={8} />
          : <div style={{ fontSize: 10, color: t.muted, opacity: 0, textAlign: 'right', paddingRight: 4,
              fontVariantNumeric: 'tabular-nums' }} data-irc-time>{m.time}</div>}
      </div>
      <div style={{ flex: 1, minWidth: 0, paddingRight: 60 }}>
        {!grouped && (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 1 }}>
            <span style={{ fontWeight: 700, fontSize: 13, color: nameColor, letterSpacing: '-0.005em' }}>
              {author.name}
            </span>
            <span style={{ fontSize: 11, color: t.muted, fontVariantNumeric: 'tabular-nums' }}>
              {m.time}
            </span>
            {mine && (
              <span style={{ color: m.read ? t.accent : t.muted, marginLeft: -2,
                display: 'inline-flex', alignItems: 'center' }}>
                {m.read ? <Icons.DoubleCheck/> : <Icons.Check/>}
              </span>
            )}
          </div>
        )}
        {m.reply && (
          <div style={{
            borderLeft: `2px solid ${t.accent}`,
            padding: '2px 0 2px 10px', marginBottom: 3, color: t.muted, fontSize: 13,
          }}>
            <span style={{ color: t.accent, fontWeight: 600, marginRight: 6 }}>↳ {m.reply.name}</span>
            <span style={{ opacity: 0.8 }}>{m.reply.text}</span>
          </div>
        )}
        <div onClick={onCtx} style={{
          fontSize: 14, lineHeight: 1.5, color: t.text, cursor: 'pointer',
          wordBreak: 'break-word',
        }}>{m.text}</div>
      </div>
      <div data-irc-actions style={{
        position: 'absolute', right: 6, top: grouped ? -10 : 4, zIndex: 2,
        display: 'flex', gap: 2, padding: 3, borderRadius: 8,
        background: t.menuBg, border: `1px solid ${t.border}`,
        boxShadow: '0 4px 12px rgba(0,0,0,.15)',
        opacity: 0, transition: 'opacity .12s', pointerEvents: ctxOpen ? 'auto' : undefined,
      }}>
        {['👍','❤️','😂'].map(e => (
          <button key={e} style={{
            width: 24, height: 24, borderRadius: 5, border: 'none', cursor: 'pointer',
            background: 'transparent', fontSize: 14,
          }}
          onMouseEnter={ev => ev.currentTarget.style.background = t.hoverRow}
          onMouseLeave={ev => ev.currentTarget.style.background = 'transparent'}>{e}</button>
        ))}
        <span style={{ width: 1, background: t.border, margin: '4px 2px' }}/>
        <button onClick={onReply} style={{
          width: 24, height: 24, borderRadius: 5, border: 'none', cursor: 'pointer',
          background: 'transparent', color: t.muted,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
        onMouseEnter={ev => { ev.currentTarget.style.background = t.hoverRow; ev.currentTarget.style.color = t.text; }}
        onMouseLeave={ev => { ev.currentTarget.style.background = 'transparent'; ev.currentTarget.style.color = t.muted; }}><Icons.Reply/></button>
        <button onClick={onCtx} style={{
          width: 24, height: 24, borderRadius: 5, border: 'none', cursor: 'pointer',
          background: 'transparent', color: t.muted,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
        onMouseEnter={ev => { ev.currentTarget.style.background = t.hoverRow; ev.currentTarget.style.color = t.text; }}
        onMouseLeave={ev => { ev.currentTarget.style.background = 'transparent'; ev.currentTarget.style.color = t.muted; }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>
        </button>
      </div>
      {ctxOpen && <V1CtxMenu t={t} onReply={onReply} onInfo={onInfo} mine={false}/>}
    </div>
  );
}

function V1CtxMenu({ t, onReply, onInfo, mine }) {
  return (
    <div style={{
      position: 'absolute', top: '100%', [mine ? 'right' : 'left']: 0,
      marginTop: 4, background: t.menuBg, borderRadius: 12,
      border: `1px solid ${t.border}`,
      boxShadow: '0 16px 40px rgba(0,0,0,.25)', padding: 6, minWidth: 180, zIndex: 5,
    }}>
      <div style={{ display: 'flex', gap: 4, padding: '4px 6px 8px', borderBottom: `1px solid ${t.border}`, marginBottom: 4 }}>
        {['👍','❤️','😂','🎉','🤔'].map(e => (
          <button key={e} style={{
            width: 30, height: 30, borderRadius: 8, border: 'none', cursor: 'pointer',
            background: 'transparent', fontSize: 18, transition: 'background .12s, transform .12s',
          }} onMouseEnter={e2 => { e2.currentTarget.style.background = t.hoverRow; e2.currentTarget.style.transform = 'scale(1.15)'; }}
             onMouseLeave={e2 => { e2.currentTarget.style.background = 'transparent'; e2.currentTarget.style.transform = 'scale(1)'; }}>
            {e}
          </button>
        ))}
      </div>
      {[
        { icon: <Icons.Reply/>, label: 'Ответить', onClick: onReply },
        { icon: <Icons.Copy/>, label: 'Скопировать' },
        { icon: <Icons.Info/>, label: 'Информация', onClick: onInfo },
        { icon: <Icons.Trash/>, label: 'Удалить', danger: true },
      ].map((it, i) => (
        <button key={i} onClick={it.onClick} style={{
          display: 'flex', alignItems: 'center', gap: 10, width: '100%',
          padding: '8px 10px', borderRadius: 8, border: 'none', background: 'transparent',
          color: it.danger ? '#ef4444' : t.text, cursor: 'pointer', fontSize: 13,
          fontFamily: 'inherit', textAlign: 'left',
        }}
        onMouseEnter={e => e.currentTarget.style.background = t.hoverRow}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
          {it.icon}<span>{it.label}</span>
        </button>
      ))}
    </div>
  );
}

function V1Modal({ t, onClose, children, width = 460 }) {
  return (
    <div onClick={onClose} style={{
      position: 'absolute', inset: 0, background: 'rgba(8,10,18,.55)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width, maxHeight: '88%', background: t.modalBg, borderRadius: 18,
        border: `1px solid ${t.border}`, boxShadow: '0 24px 60px rgba(0,0,0,.4)',
        overflow: 'hidden', display: 'flex', flexDirection: 'column',
      }}>{children}</div>
    </div>
  );
}

function V1Settings({ t, theme, setTheme, view, setView, onClose }) {
  const [fontSize, setFontSize] = React.useState('M');
  return (
    <V1Modal t={t} onClose={onClose} width={500}>
      <div style={{ padding: '20px 24px 16px', display: 'flex', alignItems: 'center', borderBottom: `1px solid ${t.border}` }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Настройки</h2>
        <button onClick={onClose} style={{ ...iconBtn(t), marginLeft: 'auto' }}><Icons.Close/></button>
      </div>
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20, overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <Avatar peer={{ ...ME, color: t.accent }} size={56} radius={16} />
          <div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>{ME.name}</div>
            <div style={{ fontSize: 13, color: t.muted }}>@{ME.username}</div>
          </div>
          <button style={{
            marginLeft: 'auto', padding: '8px 14px', borderRadius: 10,
            background: t.accentSoft, color: t.accent, border: 'none', fontWeight: 600,
            fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
          }}>Изменить</button>
        </div>

        <V1Section t={t} label="Внешний вид">
          <V1SegRow t={t} label="Тема" value={theme} options={[['light','Светлая'],['dark','Тёмная']]} onChange={setTheme}/>
          <V1SegRow t={t} label="Размер текста" value={fontSize} options={[['S','S'],['M','M'],['L','L']]} onChange={setFontSize}/>
          <V1SegRow t={t} label="Стиль" value={view} options={[['bubbles','Пузыри'],['irc','IRC']]} onChange={setView}/>
        </V1Section>

        <V1Section t={t} label="Уведомления">
          <V1Toggle t={t} label="Звук сообщений" defaultOn/>
          <V1Toggle t={t} label="Превью в уведомлениях"/>
          <V1Toggle t={t} label="Автозапуск при старте"/>
        </V1Section>

        <button style={{
          padding: '12px', borderRadius: 12, border: `1px solid ${t.dangerBorder}`,
          background: t.dangerBg, color: '#ef4444', fontWeight: 600, fontSize: 14,
          cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        }}>Выйти из аккаунта</button>
        <div style={{ fontSize: 11, color: t.muted, textAlign: 'center' }}>2026 © bolgov0zero · v1.4.22</div>
      </div>
    </V1Modal>
  );
}

function V1Section({ t, label, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em',
        textTransform: 'uppercase', color: t.muted, marginBottom: 8 }}>{label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4,
        background: t.cardBg, borderRadius: 12, border: `1px solid ${t.border}`, padding: 4 }}>
        {children}
      </div>
    </div>
  );
}

function V1SegRow({ t, label, value, options, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '8px 12px' }}>
      <span style={{ flex: 1, fontSize: 14 }}>{label}</span>
      <div style={{ display: 'flex', gap: 2, padding: 2, background: t.searchBg, borderRadius: 10 }}>
        {options.map(([k, lbl]) => (
          <button key={k} onClick={() => onChange(k)} style={{
            padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
            background: value === k ? t.accent : 'transparent',
            color: value === k ? '#fff' : t.muted,
            fontWeight: 600, fontSize: 12, fontFamily: 'inherit',
            transition: 'all .15s',
          }}>{lbl}</button>
        ))}
      </div>
    </div>
  );
}

function V1Toggle({ t, label, defaultOn }) {
  const [on, setOn] = React.useState(!!defaultOn);
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '8px 12px' }}>
      <span style={{ flex: 1, fontSize: 14 }}>{label}</span>
      <button onClick={() => setOn(!on)} style={{
        width: 36, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer',
        background: on ? t.accent : t.searchBg, position: 'relative', transition: 'background .15s',
      }}>
        <span style={{
          position: 'absolute', top: 2, left: on ? 16 : 2, width: 18, height: 18,
          borderRadius: '50%', background: '#fff', transition: 'left .15s',
          boxShadow: '0 1px 3px rgba(0,0,0,.2)',
        }}/>
      </button>
    </div>
  );
}

function V1NewChat({ t, onClose }) {
  const [tab, setTab] = React.useState('personal');
  return (
    <V1Modal t={t} onClose={onClose} width={440}>
      <div style={{ padding: '20px 24px 16px', display: 'flex', alignItems: 'center', borderBottom: `1px solid ${t.border}` }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Новый чат</h2>
        <button onClick={onClose} style={{ ...iconBtn(t), marginLeft: 'auto' }}><Icons.Close/></button>
      </div>
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', gap: 4, padding: 4, background: t.searchBg, borderRadius: 12 }}>
          {[['personal','Личный',<Icons.User/>],['group','Группа',<Icons.Users/>]].map(([k,lbl,ic]) => (
            <button key={k} onClick={() => setTab(k)} style={{
              flex: 1, padding: '10px', borderRadius: 9, border: 'none', cursor: 'pointer',
              background: tab === k ? t.accent : 'transparent',
              color: tab === k ? '#fff' : t.muted, fontWeight: 600, fontSize: 13, fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}>{ic}{lbl}</button>
          ))}
        </div>
        {tab === 'group' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 44, height: 44, borderRadius: 14, background: t.accent, color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 18,
            }}>G</div>
            <input placeholder="Название группы" style={{
              flex: 1, background: t.searchBg, border: `1px solid ${t.border}`,
              borderRadius: 10, padding: '10px 14px', color: t.text, fontSize: 14,
              outline: 'none', fontFamily: 'inherit',
            }}/>
          </div>
        )}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: t.searchBg, borderRadius: 10, padding: '9px 12px',
        }}>
          <span style={{ color: t.muted }}><Icons.Search/></span>
          <input placeholder="Поиск контактов..." style={{
            background: 'transparent', border: 'none', outline: 'none', color: t.text,
            fontSize: 14, flex: 1, fontFamily: 'inherit',
          }}/>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 240, overflowY: 'auto' }}>
          {Object.values(PEERS).slice(0, 5).map(p => (
            <button key={p.id} style={{
              display: 'flex', alignItems: 'center', gap: 12, width: '100%',
              padding: '8px', borderRadius: 10, border: 'none', cursor: 'pointer',
              background: 'transparent', color: t.text, textAlign: 'left', fontFamily: 'inherit',
            }}
            onMouseEnter={e => e.currentTarget.style.background = t.hoverRow}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
              <Avatar peer={p} size={36} radius={10} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</div>
                <div style={{ fontSize: 12, color: t.muted }}>@{p.username}</div>
              </div>
              {tab === 'group' && (
                <span style={{ width: 22, height: 22, borderRadius: 6, border: `1.5px solid ${t.border}` }}/>
              )}
            </button>
          ))}
        </div>
        {tab === 'group' && (
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
            <button onClick={onClose} style={{
              padding: '10px 16px', borderRadius: 10, border: `1px solid ${t.border}`,
              background: 'transparent', color: t.text, fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
            }}>Отмена</button>
            <button style={{
              padding: '10px 16px', borderRadius: 10, border: 'none',
              background: t.accent, color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
              boxShadow: `0 6px 16px ${t.accentShadow}`,
            }}>Создать группу</button>
          </div>
        )}
      </div>
    </V1Modal>
  );
}

function V1Info({ t, onClose }) {
  return (
    <V1Modal t={t} onClose={onClose} width={380}>
      <div style={{ padding: '20px 24px 16px', display: 'flex', alignItems: 'center', borderBottom: `1px solid ${t.border}` }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Информация</h2>
        <button onClick={onClose} style={{ ...iconBtn(t), marginLeft: 'auto' }}><Icons.Close/></button>
      </div>
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {[
          ['Отправлено', '15.05.2026 · 16:47'],
          ['Доставлено', '15.05.2026 · 16:47'],
          ['Прочитано', '15.05.2026 · 16:47'],
        ].map(([k,v]) => (
          <div key={k} style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '12px 14px', background: t.cardBg, borderRadius: 12,
            border: `1px solid ${t.border}`,
          }}>
            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em',
              textTransform: 'uppercase', color: t.muted }}>{k}</span>
            <span style={{ fontWeight: 600, fontSize: 14, fontVariantNumeric: 'tabular-nums' }}>{v}</span>
          </div>
        ))}
      </div>
    </V1Modal>
  );
}

function V1Update({ t, onClose }) {
  return (
    <V1Modal t={t} onClose={onClose} width={400}>
      <div style={{ padding: '22px 22px 18px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{
          width: 48, height: 48, borderRadius: 14, background: '#10b981',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
        }}><Icons.Refresh/></div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 16 }}>Доступно обновление</div>
          <div style={{ fontSize: 12, color: t.muted }}>v1.4.23 · 2.4 МБ</div>
        </div>
      </div>
      <div style={{ padding: '14px 22px', borderTop: `1px solid ${t.border}`, borderBottom: `1px solid ${t.border}` }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em',
          textTransform: 'uppercase', color: t.muted, marginBottom: 6 }}>Что нового</div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
          <li>Полностью переработанный интерфейс</li>
          <li>Светлая и тёмная темы</li>
          <li>Реакции на сообщения</li>
        </ul>
      </div>
      <div style={{ padding: '14px 22px', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={{
          padding: '10px 16px', borderRadius: 10, border: `1px solid ${t.border}`,
          background: 'transparent', color: t.text, fontWeight: 600, fontSize: 13,
          cursor: 'pointer', fontFamily: 'inherit',
        }}>Пропустить</button>
        <button onClick={onClose} style={{
          padding: '10px 16px', borderRadius: 10, border: 'none',
          background: t.accent, color: '#fff', fontWeight: 600, fontSize: 13,
          cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6,
          boxShadow: `0 6px 16px ${t.accentShadow}`,
        }}><Icons.Refresh/>Обновить и перезапустить</button>
      </div>
    </V1Modal>
  );
}

function iconBtn(t, color) {
  return {
    width: 34, height: 34, borderRadius: 10, border: 'none', cursor: 'pointer',
    background: 'transparent', color: color || t.muted,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'background .12s, color .12s', flexShrink: 0,
  };
}

const V1 = {
  dark: {
    appBg: '#0b0d14',
    sideBg: 'rgba(20,22,32,0.7)',
    headerBg: 'rgba(11,13,20,0.7)',
    searchBg: 'rgba(255,255,255,0.04)',
    activeRow: 'rgba(99,102,241,0.16)',
    hoverRow: 'rgba(255,255,255,0.04)',
    border: 'rgba(255,255,255,0.06)',
    text: '#e9eaf2',
    muted: '#8a8fa3',
    accent: '#6366f1',
    accentSoft: 'rgba(99,102,241,0.18)',
    accentShadow: 'rgba(99,102,241,0.35)',
    bubbleMine: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
    bubbleOther: 'rgba(255,255,255,0.06)',
    bubbleShadow: '0 2px 8px rgba(0,0,0,0.25)',
    daypill: 'rgba(255,255,255,0.04)',
    composerBg: 'rgba(255,255,255,0.04)',
    replyBg: 'rgba(99,102,241,0.10)',
    modalBg: '#13151f',
    cardBg: 'rgba(255,255,255,0.03)',
    dangerBg: 'rgba(239,68,68,0.08)',
    dangerBorder: 'rgba(239,68,68,0.3)',
    menuBg: '#1c1e2a',
    blob1: 'rgba(99,102,241,0.18)',
    blob2: 'rgba(139,92,246,0.15)',
  },
  light: {
    appBg: '#f7f7fb',
    sideBg: 'rgba(255,255,255,0.7)',
    headerBg: 'rgba(255,255,255,0.8)',
    searchBg: 'rgba(15,23,42,0.04)',
    activeRow: 'rgba(99,102,241,0.1)',
    hoverRow: 'rgba(15,23,42,0.04)',
    border: 'rgba(15,23,42,0.08)',
    text: '#0f172a',
    muted: '#64748b',
    accent: '#6366f1',
    accentSoft: 'rgba(99,102,241,0.12)',
    accentShadow: 'rgba(99,102,241,0.25)',
    bubbleMine: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
    bubbleOther: '#ffffff',
    bubbleShadow: '0 2px 8px rgba(15,23,42,0.06)',
    daypill: 'rgba(15,23,42,0.04)',
    composerBg: '#ffffff',
    replyBg: 'rgba(99,102,241,0.08)',
    modalBg: '#ffffff',
    cardBg: '#fafafa',
    dangerBg: 'rgba(239,68,68,0.05)',
    dangerBorder: 'rgba(239,68,68,0.25)',
    menuBg: '#ffffff',
    blob1: 'rgba(99,102,241,0.12)',
    blob2: 'rgba(236,72,153,0.10)',
  },
};

Object.assign(window, { ChatV1 });
