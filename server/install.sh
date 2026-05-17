#!/bin/bash
set -e

echo "╔══════════════════════════════════════════╗"
echo "║     Corp Chat Server — установка         ║"
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
SERVICE_NAME="corp-chat"
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

# ── Systemd сервис ──
echo "→ Настройка автозапуска..."
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Corp Chat Server
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
  echo "    systemctl status $SERVICE_NAME"
  echo "    systemctl stop $SERVICE_NAME"
  echo "    journalctl -u $SERVICE_NAME -f"
  echo ""
else
  echo ""
  echo "✗ Сервер не запустился. Смотри логи:"
  echo "  journalctl -u $SERVICE_NAME -n 30 --no-pager"
  exit 1
fi
