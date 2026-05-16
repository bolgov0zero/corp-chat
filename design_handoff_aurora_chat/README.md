# Handoff: Aurora — Chat App Redesign

## Overview

Полный редизайн чат-приложения **Electron** (корпоративный мессенджер, Electron-приложение на текущем стеке) в направлении **Aurora**: современный, мягкий, с indigo-акцентом, поддержкой светлой и тёмной темы и двумя режимами отображения сообщений — **«Пузыри»** и **«IRC»**.

Заменяет текущий тёмный интерфейс (`v1.4.22`) полностью.

## About the Design Files

Файлы в этом бандле — **дизайн-референсы, написанные в HTML/React (через Babel standalone)**. Это прототипы, демонстрирующие финальный вид и поведение, а **не production-код, который нужно копировать дословно**.

Задача — **воспроизвести эти дизайны в существующем кодовом окружении Electron-приложения**, используя установленные в проекте патёрны (React/Vue/native, state-management, UI-kit, шрифтовая система и т.д.). Все хардкоженные стили из прототипа должны быть переведены в design tokens / CSS-переменные / Tailwind-конфиг — в зависимости от того, что уже используется.

## Fidelity

**High-fidelity (hifi).** Все цвета, размеры, отступы, радиусы, тени, шрифтовые размеры — финальные. Воспроизводить пиксель-в-пиксель, но через токены/переменные, а не магические числа.

## Screens / Views

### 1. Главный экран (chat)

Двухпанельный layout: сайдбар слева (296px фикс), область диалога — справа (flex: 1).

#### Сайдбар (296px)

Сверху вниз:

1. **Шапка пользователя** (padding `14px 14px 10px`, flex row, gap 10):
   - Avatar 36×36, radius 12, цвет = accent, white initial
   - Имя (font-weight 600, 14px) + статус-строка (12px, muted) с зелёной точкой 6×6 (`#22c55e`) и текстом «онлайн»
   - 3 icon-кнопки 34×34, radius 10: тема (Sun/Moon), настройки (Cog), новый чат (Compose)

2. **Поиск** (padding `4px 14px 12px`):
   - Контейнер: background `searchBg`, radius 12, padding `9px 12px`, border `1px solid border`
   - Лупа (Search icon, color muted) + input «Поиск» (transparent, 14px) + ярлык `⌘K` (kbd: 11px, border, radius 5)

3. **Список чатов** (flex: 1, overflowY auto, padding `0 8px 12px`):
   - Группы: «ЗАКРЕПЛЁННЫЕ» (uppercase 11px, weight 600, letter-spacing 0.06em, color muted, padding `8px 8px 6px`), затем «ВСЕ ЧАТЫ»
   - Строка чата: 
     - padding `10px 10px`, radius 12, gap 12, marginBottom 2
     - Active: background `activeRow` + левый акцент-стрип (absolute, left -8, 3×24px, radius 2, color accent)
     - Hover: background `hoverRow`
     - Avatar 40×40 radius 12
     - Имя (weight 600, 14px) + время (11px, muted) + иконка pin (опционально, если pinned)
     - Превью последнего сообщения (13px, muted, truncate) + бейдж непрочитанных: minWidth 18, height 18, padding `0 6px`, radius 9, background accent, color #fff, 11px weight 600

#### Область диалога

1. **Шапка** (height 64px, padding `0 20px`, flex row gap 12, borderBottom):
   - Avatar 40×40 radius 12
   - Имя (weight 600, 15px) + бейдж BOT (10px, padding `1px 6px`, radius 4, background accentSoft, color accent, weight 600) если бот
   - Подпись «в сети» / «был(а) недавно · Личный чат» (12px, muted)
   - Icon-кнопки 34×34: переключатель режима (Bubble↔IRC; иконка меняется), обновление, инфо, удалить (color #ef4444 на hover)

2. **Лента сообщений** (flex: 1, overflowY auto, padding `20px 24px 12px`):
   - Внутренний `maxWidth: 760, margin: 0 auto`, flex column gap 8
   - День-разделитель: pill, alignSelf center, padding `4px 12px`, background daypill, radius 999, 12px muted, border
   - **Сообщения** рендерятся в одном из двух режимов — см. ниже

3. **Composer** (padding `12px 24px 18px`):
   - Внутренний maxWidth 760
   - Если reply активен — блок reply-preview сверху (borderLeft 3px solid accent, padding `8px 10px 8px 12px`, radius `10px 10px 4px 4px`)
   - Контейнер input: flex row gap 8, background composerBg, radius 18 (или `4px 4px 18px 18px` при активном reply), padding `8px 8px 8px 14px`, border
   - Скрепка, эмодзи (icon-кнопки) + input (transparent, 14px) + кнопка отправки 38×38 radius 12 (или микрофон если drafts пуст)
   - Кнопка send: background accent, color white, boxShadow `0 6px 16px accentShadow`

### 2. Режим «Пузыри» (bubbles)

- Сообщения выровнены по сторонам: свои справа, чужие слева, maxWidth 70%
- Аватар собеседника 32×32 radius 10 слева (только у первого в группе)
- Над пузырём — имя автора (12px, muted, weight 600) у не-своих
- **Пузырь**:
  - Своё: `background: linear-gradient(135deg, #6366f1, #8b5cf6)`, color white
  - Чужое: background `bubbleOther`, color text
  - Padding `8px 12px 6px`, radius 16 (внутренние углы 6 на стороне примыкания)
  - boxShadow для своих: `0 4px 14px accentShadow`; для чужих: `0 2px 8px rgba(0,0,0,0.25)` (dark) / `0 2px 8px rgba(15,23,42,0.06)` (light)
- Время и галочки внутри пузыря, float right, 11px, цвет полупрозрачный
- Reply-блок внутри пузыря: borderLeft 3px (rgba(255,255,255,.55) для своих или accent для чужих), padding `4px 8px`, marginBottom 6, radius 6, background-tint

### 3. Режим «IRC»

- Сообщения **левоустановленные**, без пузырей, более плотные
- Сетка: аватар-колонка 28px + контент с правым отступом 60px (под действия)
- Группировка: первое сообщение от автора показывает аватар + строку-шапку (имя + время + галочки), последующие — только текст с отступом
- **Имя автора цветное** — `mine ? accent : peer.color`, weight 700, 13px
- Время рядом с именем (11px, muted, `font-variant-numeric: tabular-nums`)
- Текст сообщения 14px, line-height 1.5
- При hover на строке — справа всплывает мини-панель действий: реакции (👍 ❤️ 😂) + reply + ⋯, фоновая background menuBg, border, radius 8, padding 3, gap 2

### 4. Модалки

Все модалки центрированы по экрану, overlay `rgba(8,10,18,.55) + backdropFilter blur(6px)`, контейнер: background modalBg, radius 18, border 1px, boxShadow `0 24px 60px rgba(0,0,0,.4)`.

- **Настройки** (width 500): профиль + блок «Внешний вид» (тема, размер текста, стиль) + «Уведомления» (тогглы) + кнопка «Выйти» (color #ef4444, border #ef4444 25%, background `rgba(239,68,68,0.05–0.08)`). Каждая секция = label-uppercase + cardBg-контейнер с padding 4 и radius 12.
- **Новый чат / Группа** (width 440): сегментированный таб «Личный / Группа», если группа — поле «Название группы» с заглушкой-аватаром, поиск, список контактов. Кнопка «Создать группу» = accent + boxShadow.
- **Информация о сообщении** (width 380): три карточки «Отправлено / Доставлено / Прочитано» с UPPERCASE-меткой и tabular-датой.
- **Доступно обновление** (width 400): иконка 48×48 radius 14 (background #10b981), заголовок + версия, секция «что нового» с маркированным списком, кнопки «Пропустить» (outline) + «Обновить и перезапустить» (accent).

### 5. Контекстное меню сообщения

Появляется по клику на сообщение. Position absolute, top: 100%, выравнивается по стороне сообщения. Background menuBg, border, radius 12, boxShadow `0 16px 40px rgba(0,0,0,.25)`, padding 6, minWidth 180.

- Верхняя полоса реакций (👍 ❤️ 😂 🎉 🤔), кнопки 30×30 radius 8, при hover background hoverRow + scale(1.15)
- Разделитель border-bottom
- Пункты: Ответить (Reply icon), Скопировать (Copy icon), Информация (Info icon), Удалить (Trash icon, color #ef4444)
- Каждый пункт: padding `8px 10px`, radius 8, gap 10, fontSize 13

## Interactions & Behavior

- **Переключение темы**: клик на Sun/Moon в шапке сайдбара или в Настройках → переключает все цвета через токены (плавный transition `background .25s, color .25s` на корневом контейнере)
- **Переключение режима пузыри ↔ IRC**: клик на иконку в шапке диалога или в Настройках. При смене — пересоздание ленты сообщений, без анимации.
- **Reply**: клик на «Ответить» в меню → reply-preview появляется над composer, в кружке `×` для отмены. При отправке — reply-блок встраивается в пузырь.
- **Composer**: пока draft пуст, справа — иконка микрофона. Как только есть текст — иконка меняется на «отправить» (accent, glowing shadow).
- **Hover на строке IRC**: справа всплывает панель быстрых действий с opacity transition 120ms.
- **Активный чат в сайдбаре**: левая accent-полоска + tinted background (`activeRow`).
- **Online-индикатор**: зелёная точка 30%-от-аватара в правом-нижнем углу, с 2px ring цвета `ring` (фон контейнера, чтобы не сливалось).
- **Группировка сообщений**: если предыдущее сообщение от того же автора и не разделитель дня — скрыть аватар/имя у текущего, прижать вплотную (marginTop -4 в bubbles, padding 1px 0 в IRC).

## State Management

```ts
{
  theme: 'dark' | 'light',
  view: 'bubbles' | 'irc',
  activeChat: string,
  modal: null | 'settings' | 'new' | 'info' | 'update',
  ctxMenu: null | string,        // id сообщения с открытым меню
  draft: string,
  replyTo: null | Message,
}
```

Сохранять `theme` и `view` в локальное хранилище приложения (Electron `electron-store` или аналог), чтобы между перезапусками сохранялись.

## Design Tokens

### Цвета — тёмная тема

| Token | Hex / rgba |
|---|---|
| appBg | `#0b0d14` |
| sideBg | `rgba(20,22,32,0.7)` (с backdrop-blur 20px) |
| headerBg | `rgba(11,13,20,0.7)` |
| searchBg | `rgba(255,255,255,0.04)` |
| activeRow | `rgba(99,102,241,0.16)` |
| hoverRow | `rgba(255,255,255,0.04)` |
| border | `rgba(255,255,255,0.06)` |
| text | `#e9eaf2` |
| muted | `#8a8fa3` |
| accent | `#6366f1` |
| accentSoft | `rgba(99,102,241,0.18)` |
| accentShadow | `rgba(99,102,241,0.35)` |
| bubbleMine | `linear-gradient(135deg, #6366f1, #8b5cf6)` |
| bubbleOther | `rgba(255,255,255,0.06)` |
| bubbleShadow | `0 2px 8px rgba(0,0,0,0.25)` |
| daypill | `rgba(255,255,255,0.04)` |
| composerBg | `rgba(255,255,255,0.04)` |
| replyBg | `rgba(99,102,241,0.10)` |
| modalBg | `#13151f` |
| cardBg | `rgba(255,255,255,0.03)` |
| menuBg | `#1c1e2a` |
| dangerBg | `rgba(239,68,68,0.08)` |
| dangerBorder | `rgba(239,68,68,0.3)` |
| blob1 (декор) | `rgba(99,102,241,0.18)` |
| blob2 (декор) | `rgba(139,92,246,0.15)` |

### Цвета — светлая тема

| Token | Hex / rgba |
|---|---|
| appBg | `#f7f7fb` |
| sideBg | `rgba(255,255,255,0.7)` |
| headerBg | `rgba(255,255,255,0.8)` |
| searchBg | `rgba(15,23,42,0.04)` |
| activeRow | `rgba(99,102,241,0.1)` |
| hoverRow | `rgba(15,23,42,0.04)` |
| border | `rgba(15,23,42,0.08)` |
| text | `#0f172a` |
| muted | `#64748b` |
| accent | `#6366f1` (тот же) |
| accentSoft | `rgba(99,102,241,0.12)` |
| accentShadow | `rgba(99,102,241,0.25)` |
| bubbleMine | `linear-gradient(135deg, #6366f1, #8b5cf6)` |
| bubbleOther | `#ffffff` |
| bubbleShadow | `0 2px 8px rgba(15,23,42,0.06)` |
| daypill | `rgba(15,23,42,0.04)` |
| composerBg | `#ffffff` |
| replyBg | `rgba(99,102,241,0.08)` |
| modalBg | `#ffffff` |
| cardBg | `#fafafa` |
| menuBg | `#ffffff` |
| dangerBg | `rgba(239,68,68,0.05)` |
| dangerBorder | `rgba(239,68,68,0.25)` |
| blob1 | `rgba(99,102,241,0.12)` |
| blob2 | `rgba(236,72,153,0.10)` |

### Декоративные «blob»-градиенты

Фон приложения дополнен двумя размытыми цветными blob'ами:
- **blob1**: `position: absolute; top: -120px; left: -80px; width: 360px; height: 360px; background: radial-gradient(circle, blob1 0%, transparent 65%); filter: blur(20px); pointer-events: none;`
- **blob2**: `position: absolute; bottom: -160px; right: -120px; width: 420px; height: 420px; …` с blob2

Это даёт тёплое свечение по углам, без отвлечения.

### Типографика

- **Шрифт**: `-apple-system, BlinkMacSystemFont, 'Inter', 'SF Pro Text', system-ui, sans-serif`
- Размеры: 11 (метки/время) · 12 (вторичный) · 13 (превью/UI) · 14 (тело/сообщения) · 15 (заголовок чата) · 16 (заголовок настроек) · 18 (заголовки модалок)
- Weights: 400 normal / 600 semibold / 700 bold
- В UPPERCASE-метках: `letter-spacing: 0.06em`
- Tabular numerals у дат/времени (`font-variant-numeric: tabular-nums`)

### Spacing scale

`2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 32` — сетка кратна 2px.

### Border radius

| Контекст | Radius |
|---|---|
| маленький (kbd, badge) | 4–5px |
| icon button | 10px |
| avatar (sm/md) | 8–12px |
| inputs / search / row | 10–12px |
| bubble | 16px (углы примыкания 6px) |
| composer (общий) | 18px |
| modal | 18px |
| icon-tile (большая 48×48) | 14px |

### Shadows

- Bubble (своё): `0 4px 14px <accentShadow>`
- Bubble (чужое, dark): `0 2px 8px rgba(0,0,0,0.25)`
- Bubble (чужое, light): `0 2px 8px rgba(15,23,42,0.06)`
- Send button: `0 6px 16px <accentShadow>`
- Menu / dropdown: `0 16px 40px rgba(0,0,0,.25)`
- Modal: `0 24px 60px rgba(0,0,0,.4)` (dark) / soft equiv (light)

## Assets / Icons

Все иконки — lucide-style, моноширинно нарисованные SVG. В проекте использовалась библиотека **lucide-react** или эквивалент. Размер по умолчанию 16×16 (мелкие, в строках), 18×18 (стандарт, в шапке и кнопках), `strokeWidth: 2`, `strokeLinecap: 'round'`, `strokeLinejoin: 'round'`.

Используемые иконки (имена в lucide-react):
- `Search`, `Settings`, `PenLine` (Compose), `Trash2`, `Send`, `Smile`, `Check`, `CheckCheck`, `X` (Close), `Plus`, `User`, `Users`, `Sun`, `Moon`, `RefreshCw`, `Reply`, `Copy`, `Info`, `Pin`, `Paperclip`, `Mic`, `MoreHorizontal`

Аватары пользователей — пока цветные квадратики с инициалом (заглушка). В проде заменить на реальные фото с тем же `radius` и `boxShadow`-ring для статус-индикатора.

## Recommendations for the dev

- Вынести палитру в **CSS-переменные** на `:root` и `:root[data-theme=light]`, чтобы переключение темы было через смену атрибута на `<html>` (плавно через `transition`).
- Использовать **CSS-grid** для главного layout (вместо двух flex'ов) — упростит респонсив.
- Для модалок использовать **`<dialog>` элемент** или существующую модал-систему проекта (focus trap, esc-to-close, scroll-lock).
- Аккуратно с `backdrop-filter: blur` — у некоторых linux-сборок Electron он работает только при включённом GPU-композитинге. Иметь fallback с плоским цветом.
- Структура: разнести на компоненты `Sidebar`, `ChatList`, `ChatRow`, `ChatHeader`, `MessageList`, `MessageBubble`, `MessageIRC`, `Composer`, `ReplyPreview`, `ContextMenu`, `Modal`, `SettingsModal` и т.д.

## Files in this bundle

- `prototype.html` — самодостаточный референс-прототип (открыть в браузере)
- `chat-v1.jsx` — исходный React-компонент Aurora (с переключением темы и режима)
- `shared.jsx` — общие данные, аватары и иконки
- `design-canvas.jsx` — обёртка-канвас (нужна только для запуска прототипа)
