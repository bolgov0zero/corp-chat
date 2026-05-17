#!/bin/bash
set -e

echo "╔══════════════════════════════════════════╗"
echo "║        Electorn — установка              ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── Проверка root ──
if [ "$EUID" -ne 0 ]; then
  echo "✗ Запусти скрипт от root: sudo bash install.sh"
  exit 1
fi

# ── Параметры ──
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-3000}"
SERVICE_NAME="electorn"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
DB_DIR="${DB_DIR:-$APP_DIR/../chat_db}"

# ── Определение дистрибутива ──
if [ -f /etc/debian_version ]; then
  PKG="apt"
elif [ -f /etc/redhat-release ] || [ -f /etc/centos-release ]; then
  PKG="yum"
elif [ -f /etc/arch-release ]; then
  PKG="pacman"
else
  echo "✗ Неизвестный дистрибутив. Установи Node.js 20+ вручную."
  exit 1
fi

echo "→ Дистрибутив: $PKG | Архитектура: $(uname -m)"

# ── Установка Node.js ──
install_node_apt() {
  echo "→ Установка Node.js 20..."
  apt-get update -q
  apt-get install -y curl ca-certificates build-essential python3
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
}

install_node_yum() {
  echo "→ Установка Node.js 20..."
  yum install -y curl ca-certificates gcc gcc-c++ make python3 2>/dev/null || \
    dnf install -y curl ca-certificates gcc gcc-c++ make python3
  curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
  yum install -y nodejs 2>/dev/null || dnf install -y nodejs
}

install_node_pacman() {
  echo "→ Установка Node.js..."
  pacman -Sy --noconfirm nodejs npm base-devel python
}

if command -v node &>/dev/null; then
  NODE_OK=$(node -e "process.exit(parseInt(process.version.slice(1)) < 18 ? 1 : 0)" 2>/dev/null && echo "ok" || echo "old")
  if [ "$NODE_OK" = "ok" ]; then
    echo "→ Node.js уже установлен: $(node --version)"
  else
    echo "→ Node.js устарел ($(node --version)), обновляем..."
    [ "$PKG" = "apt" ]    && install_node_apt
    [ "$PKG" = "yum" ]    && install_node_yum
    [ "$PKG" = "pacman" ] && install_node_pacman
  fi
else
  [ "$PKG" = "apt" ]    && install_node_apt
  [ "$PKG" = "yum" ]    && install_node_yum
  [ "$PKG" = "pacman" ] && install_node_pacman
fi

echo "→ Node.js: $(node --version) | npm: $(npm --version)"

# ── Зависимости ──
echo "→ Установка зависимостей..."
cd "$APP_DIR"
npm install --omit=dev

# ── Пересборка нативных модулей под текущую архитектуру ──
echo "→ Пересборка нативных модулей (better-sqlite3)..."
npm rebuild better-sqlite3

# ── Создание папки для БД ──
mkdir -p "$DB_DIR"
echo "→ Папка базы данных: $DB_DIR"

# ── Генерация JWT_SECRET ──
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
echo "→ JWT_SECRET сгенерирован"

# ── Остановка старых служб если есть ──
for OLD in electron corp-chat; do
  if systemctl is-active --quiet "$OLD" 2>/dev/null; then
    echo "→ Остановка старой службы $OLD..."
    systemctl stop "$OLD" 2>/dev/null || true
    systemctl disable "$OLD" 2>/dev/null || true
  fi
  [ -f "/etc/systemd/system/${OLD}.service" ] && rm -f "/etc/systemd/system/${OLD}.service"
done

# ── Systemd сервис ──
echo "→ Настройка автозапуска..."
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Electorn Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$(which node) $APP_DIR/src/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=JWT_SECRET=$JWT_SECRET
Environment=DB_PATH=$DB_DIR/chat.db

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

# ── Установка CLI-команды electorn ──
echo "→ Установка команды 'electorn'..."
chmod +x "$APP_DIR/electorn"
ln -sf "$APP_DIR/electorn" /usr/local/bin/electorn

# Установка sqlite3 для статистики БД в панели
if [ "$PKG" = "apt" ]; then
  apt-get install -y sqlite3 -q 2>/dev/null || true
elif [ "$PKG" = "yum" ]; then
  yum install -y sqlite 2>/dev/null || dnf install -y sqlite 2>/dev/null || true
elif [ "$PKG" = "pacman" ]; then
  pacman -Sy --noconfirm sqlite 2>/dev/null || true
fi

# ── Проверка ──
echo ""
echo "→ Ожидание запуска сервера..."
sleep 3

if systemctl is-active --quiet "$SERVICE_NAME"; then
  echo ""
  echo "╔══════════════════════════════════════════╗"
  echo "║           ✓ Сервер запущен!              ║"
  echo "╚══════════════════════════════════════════╝"
  echo ""
  echo "  Адрес:     http://$(hostname -I | awk '{print $1}'):$PORT"
  echo "  База:      $DB_DIR/chat.db"
  echo "  Сервис:    $SERVICE_NAME"
  echo ""
  echo "  Управление:"
  echo "    electorn          — панель управления"
  echo "    systemctl status $SERVICE_NAME"
  echo "    journalctl -u $SERVICE_NAME -f"
  echo ""
else
  echo ""
  echo "✗ Сервер не запустился. Смотри логи:"
  echo "  journalctl -u $SERVICE_NAME -n 30 --no-pager"
  exit 1
fi
