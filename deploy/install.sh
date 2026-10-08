#!/usr/bin/env bash
# Установка или обновление форума на сервере Ubuntu 22.04 / 24.04.
#   sudo bash deploy/install.sh ваш-домен.com ваша@почта.ru
# Повторный запуск обновляет код и перезапускает сайт, база и загрузки не трогаются.
set -euo pipefail
DOMAIN="${1:?Укажите домен: sudo bash deploy/install.sh example.com почта@example.com}"
EMAIL="${2:?Укажите e-mail для сертификата HTTPS вторым параметром}"
APP_DIR=/opt/forum
SRC="$(cd "$(dirname "$0")/.." && pwd)"
[ "$(id -u)" = 0 ] || { echo "Запустите через sudo"; exit 1; }

echo "== Пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q curl ca-certificates nginx certbot python3-certbot-nginx sqlite3 ufw
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi

echo "== Файлы сайта в $APP_DIR"
id forum >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin forum
mkdir -p "$APP_DIR"
if [ "$SRC" != "$APP_DIR" ]; then
  tar -C "$SRC" --exclude=./node_modules --exclude=./.node --exclude=./.bin --exclude=./_ref --exclude=./data \
      --exclude='./*.log' --exclude='./*.command' -cf - . | tar -C "$APP_DIR" -xf -
  # данные с Mac переносятся только при первой установке
  if [ -f "$SRC/data/forum.db" ] && [ ! -f "$APP_DIR/data/forum.db" ]; then cp -a "$SRC/data" "$APP_DIR/"; fi
fi
mkdir -p "$APP_DIR/data"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
chown -R forum:forum "$APP_DIR"

echo "== Служба"
[ -f /etc/forum.env ] || printf 'PORT=3000\nHOST=127.0.0.1\nNODE_ENV=production\nTRUST_PROXY=loopback\n' > /etc/forum.env
install -m 644 "$APP_DIR/deploy/forum.service" /etc/systemd/system/forum.service
systemctl daemon-reload
systemctl enable forum >/dev/null
systemctl restart forum

echo "== nginx"
# при обновлении настройки nginx (с уже подключённым HTTPS) не трогаются
[ -f /etc/nginx/sites-available/forum ] || sed "s/DOMAIN/$DOMAIN/g" "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/forum
ln -sf /etc/nginx/sites-available/forum /etc/nginx/sites-enabled/forum
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "== Брандмауэр"
ufw allow OpenSSH >/dev/null; ufw allow 'Nginx Full' >/dev/null; ufw --force enable >/dev/null

echo "== Резервные копии каждую ночь в /var/backups/forum"
install -m 755 "$APP_DIR/deploy/backup.sh" /etc/cron.daily/forum-backup

echo "== HTTPS"
if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  echo "Сертификат уже есть, продлевается автоматически. Сайт: https://$DOMAIN"
elif certbot --nginx -n --agree-tos -m "$EMAIL" --redirect -d "$DOMAIN" -d "www.$DOMAIN"; then
  echo "Готово: https://$DOMAIN"
else
  echo "Сертификат пока не выпущен: проверьте, что A-записи $DOMAIN и www.$DOMAIN указывают на этот сервер, и запустите скрипт ещё раз."
fi
sleep 2
journalctl -u forum --no-pager -n 30 | grep -E "логин|пароль|Форум запущен" || true
