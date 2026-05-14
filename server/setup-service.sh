#!/bin/bash
# Настройка автозапуска Corp Chat через systemd
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_FILE="/etc/systemd/system/corp-chat.service"
PORT="${PORT:-3000}"

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
# Раскомментируй и задай секретный ключ:
# Environment=JWT_SECRET=замени-на-случайную-строку

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable corp-chat
systemctl restart corp-chat

echo "✓ Сервис запущен. Управление:"
echo "  systemctl status corp-chat"
echo "  systemctl stop corp-chat"
echo "  journalctl -u corp-chat -f"
