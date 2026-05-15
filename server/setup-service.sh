#!/bin/bash
# Настройка автозапуска Electron через systemd
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_FILE="/etc/systemd/system/electron.service"
PORT="${PORT:-3000}"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Electron Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$(which node) $APP_DIR/src/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=$PORT
# Раскомментируй и задай секретный ключ:
# Environment=JWT_SECRET=замени-на-случайную-строку

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable electron
systemctl restart electron

echo "✓ Сервис запущен. Управление:"
echo "  systemctl status electron"
echo "  systemctl stop electron"
echo "  journalctl -u electron -f"
