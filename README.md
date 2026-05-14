# Corp Chat — Инструкция по запуску

## Содержание
1. [Структура проекта](#структура-проекта)
2. [Сервер — установка на Linux](#сервер--установка-на-linux)
3. [Сервер — веб-панель администратора](#веб-панель-администратора)
4. [Клиент — установка на macOS](#клиент--установка-на-macos)
5. [Первый вход](#первый-вход)
6. [Настройка автозапуска](#автозапуск-systemd)
7. [Переменные окружения](#переменные-окружения)
8. [Сборка клиента под другие платформы](#сборка-под-windows--linux)

---

## Структура проекта

```
Chat/
├── server/          ← серверная часть (Node.js)
│   ├── src/
│   │   ├── index.js          точка входа
│   │   ├── db.js             база данных SQLite
│   │   ├── auth.js           JWT авторизация
│   │   ├── ws.js             WebSocket
│   │   ├── routes/           REST API
│   │   └── public/admin/     веб-панель администратора
│   ├── install.sh            скрипт установки на Linux
│   └── setup-service.sh      настройка автозапуска (systemd)
└── client/          ← клиент Electron (macOS)
    ├── dist/
    │   ├── Corp Chat-1.0.0-arm64.dmg   Apple Silicon
    │   └── Corp Chat-1.0.0.dmg         Intel Mac
    └── ...
```

---

## Сервер — установка на Linux

### 1. Скопировать файлы на сервер

С локального Mac выполни в терминале:

```bash
scp -r "/Users/bolgov/Documents/My Projects/Chat/server" user@192.168.1.10:/opt/corp-chat
```

> Замени `user` и `192.168.1.10` на своего пользователя и IP сервера.

Или скопируй папку `server/` любым другим способом (флешка, общая папка и т.д.).

---

### 2. Подключиться к серверу

```bash
ssh user@192.168.1.10
cd /opt/corp-chat
```

---

### 3. Запустить установку

```bash
sudo bash install.sh
```

Скрипт автоматически:
- Определит дистрибутив (Debian/Ubuntu, CentOS/RHEL, Arch)
- Установит Node.js 20, если его нет
- Установит зависимости (`npm install`)

**Поддерживаемые дистрибутивы:**
- Ubuntu / Debian
- CentOS / RHEL / Rocky Linux
- Arch Linux

---

### 4. Запустить сервер

```bash
node src/index.js
```

Ожидаемый вывод:
```
Created default admin user: admin / admin
Corp Chat server running on http://0.0.0.0:3000
Admin panel: http://localhost:3000/admin
```

Сервер запущен на порту **3000**. Чтобы использовать другой порт:

```bash
PORT=8080 node src/index.js
```

---

## Веб-панель администратора

Открой в браузере на любом компьютере в сети:

```
http://<IP-сервера>:3000/admin
```

**Логин по умолчанию:** `admin` / `admin`

> ⚠️ Смени пароль сразу после первого входа: раздел «Пользователи» → кнопка «Пароль» напротив admin.

### Возможности панели:
| Раздел | Что можно делать |
|--------|-----------------|
| Главная | Общая статистика (пользователи, чаты, сообщения) |
| Пользователи | Создать, удалить пользователя, сменить пароль |
| Чаты | Просмотр всех чатов, удаление чата, очистка истории |

---

## Клиент — установка на macOS

### Apple Silicon (M1/M2/M3/M4)

1. Открой папку `client/dist/`
2. Дважды щёлкни `Corp Chat-1.0.0-arm64.dmg`
3. Перетащи **Corp Chat** в папку **Applications**

### Intel Mac

1. Открой папку `client/dist/`
2. Дважды щёлкни `Corp Chat-1.0.0.dmg`
3. Перетащи **Corp Chat** в папку **Applications**

### ⚠️ Предупреждение macOS при первом запуске

Поскольку приложение не подписано сертификатом Apple, macOS заблокирует запуск. Чтобы открыть:

**Способ 1 (рекомендуется):**
1. Найди **Corp Chat** в папке Applications
2. Щёлкни **правой кнопкой мыши** → **Открыть**
3. В диалоге нажми **Открыть**
4. Больше это предупреждение не появится

**Способ 2** (через терминал):
```bash
xattr -d com.apple.quarantine /Applications/Corp\ Chat.app
```

---

## Первый вход

1. Запусти **Corp Chat** на Mac
2. В поле **«Адрес сервера»** введи IP или доменное имя сервера и порт:
   ```
   192.168.1.10:3000
   ```
3. Введи логин и пароль
4. Нажми **Войти**

### Создание пользователей для сотрудников

Через веб-панель (`http://<IP>:3000/admin`):
1. Перейди в раздел **Пользователи**
2. Нажми **«+ Создать пользователя»**
3. Заполни логин, имя, пароль

---

## Автозапуск (systemd)

Чтобы сервер стартовал автоматически при перезагрузке:

```bash
sudo bash setup-service.sh
```

### Управление сервисом:

```bash
# Статус
sudo systemctl status corp-chat

# Остановить
sudo systemctl stop corp-chat

# Запустить
sudo systemctl start corp-chat

# Перезапустить
sudo systemctl restart corp-chat

# Логи в реальном времени
sudo journalctl -u corp-chat -f
```

---

## Переменные окружения

Можно задать перед запуском или прописать в systemd-сервис:

| Переменная | По умолчанию | Описание |
|-----------|-------------|----------|
| `PORT` | `3000` | Порт сервера |
| `JWT_SECRET` | встроенный | Секретный ключ для JWT-токенов. **Обязательно смени в продакшне** |
| `DB_PATH` | `./data/chat.db` | Путь к файлу базы данных SQLite |

Пример запуска с кастомными параметрами:

```bash
PORT=8080 JWT_SECRET=мой-секретный-ключ-1234 node src/index.js
```

Чтобы задать в systemd — отредактируй `/etc/systemd/system/corp-chat.service`:
```ini
Environment=PORT=3000
Environment=JWT_SECRET=замени-на-случайную-строку
```

После изменений:
```bash
sudo systemctl daemon-reload
sudo systemctl restart corp-chat
```

---

## Сборка под Windows / Linux

Сборка выполняется на соответствующей платформе или через CI/CD.

**Windows** (запускать на Windows-машине):
```bash
cd client
npm install
npm run build:win
# Результат: client/dist/Corp Chat Setup 1.0.0.exe
```

**Linux** (запускать на Linux):
```bash
cd client
npm install
npm run build:linux
# Результат: client/dist/Corp Chat-1.0.0.AppImage
```

**Через GitHub Actions** — если нужна сборка под все платформы автоматически, скажи — добавлю конфигурацию.

---

## Порты и firewall

Если сервер с firewall, открой порт 3000 (или тот, что выбрал):

```bash
# Ubuntu / Debian (ufw)
sudo ufw allow 3000/tcp

# CentOS / RHEL (firewalld)
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload
```
