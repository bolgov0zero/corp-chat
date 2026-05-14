#!/bin/bash
set -e

echo "=== Corp Chat Server — установка ==="

# Detect OS
if [ -f /etc/debian_version ]; then
  PKG="apt"
elif [ -f /etc/redhat-release ] || [ -f /etc/centos-release ]; then
  PKG="yum"
elif [ -f /etc/arch-release ]; then
  PKG="pacman"
else
  echo "Неизвестный дистрибутив. Установите Node.js 20+ вручную и запустите: npm install && node src/index.js"
  exit 1
fi

echo "→ Менеджер пакетов: $PKG"

install_node_apt() {
  echo "→ Установка Node.js 20 (apt)..."
  apt-get update -q
  apt-get install -y curl ca-certificates
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
}

install_node_yum() {
  echo "→ Установка Node.js 20 (yum/dnf)..."
  yum install -y curl ca-certificates 2>/dev/null || dnf install -y curl ca-certificates
  curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
  yum install -y nodejs 2>/dev/null || dnf install -y nodejs
}

install_node_pacman() {
  echo "→ Установка Node.js (pacman)..."
  pacman -Sy --noconfirm nodejs npm
}

# Check if node is already installed
if command -v node &>/dev/null; then
  NODE_VER=$(node -e "process.exit(parseInt(process.version.slice(1)) < 18 ? 1 : 0)" 2>/dev/null && echo "ok" || echo "old")
  if [ "$NODE_VER" = "ok" ]; then
    echo "→ Node.js уже установлен: $(node --version)"
  else
    echo "→ Node.js устарел ($(node --version)), обновляем..."
    [ "$PKG" = "apt" ] && install_node_apt
    [ "$PKG" = "yum" ] && install_node_yum
    [ "$PKG" = "pacman" ] && install_node_pacman
  fi
else
  [ "$PKG" = "apt" ] && install_node_apt
  [ "$PKG" = "yum" ] && install_node_yum
  [ "$PKG" = "pacman" ] && install_node_pacman
fi

echo "→ Node.js: $(node --version), npm: $(npm --version)"

# Install dependencies
echo "→ Установка зависимостей..."
cd "$(dirname "$0")"
npm install --omit=dev

echo ""
echo "✓ Готово! Запуск:"
echo "  node src/index.js"
echo ""
echo "  Или настрой автозапуск (systemd):"
echo "  bash setup-service.sh"
echo ""
