#!/usr/bin/env bash
# Run ON THE VPS as root (or with sudo) from the folder that contains index.html and deploy/.
# Safe for a shared server: only creates the prayuktech.com site; never edits other sites.
set -euo pipefail
DOMAIN="prayuktech.com"
WEBROOT="/var/www/$DOMAIN"
SRC="$(cd "$(dirname "$0")/.." && pwd)"

command -v nginx >/dev/null || { echo "Nginx not found. This script expects Nginx. Stop and check what serves ExamSuit."; exit 1; }

echo "Existing enabled sites (for your reference):"; ls /etc/nginx/sites-enabled 2>/dev/null || ls /etc/nginx/conf.d

mkdir -p "$WEBROOT"
[ -f "$WEBROOT/index.html" ] && cp -a "$WEBROOT" "${WEBROOT}.bak.$(date +%s)"
cp -r "$SRC"/index.html "$SRC"/privacy-policy.html "$SRC"/css "$SRC"/js "$SRC"/assets "$WEBROOT"/
chown -R www-data:www-data "$WEBROOT" 2>/dev/null || true

if [ -d /etc/nginx/sites-available ]; then
  cp "$SRC/deploy/$DOMAIN.conf" /etc/nginx/sites-available/$DOMAIN.conf
  ln -sf /etc/nginx/sites-available/$DOMAIN.conf /etc/nginx/sites-enabled/$DOMAIN.conf
else
  cp "$SRC/deploy/$DOMAIN.conf" /etc/nginx/conf.d/$DOMAIN.conf
fi

nginx -t            # aborts here (set -e) if config is invalid, nothing reloaded
systemctl reload nginx
echo "HTTP is live: http://$DOMAIN"

echo "Enabling HTTPS with Let's Encrypt (DNS for $DOMAIN and www must already point to this server)..."
command -v certbot >/dev/null || apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d $DOMAIN -d www.$DOMAIN --redirect --non-interactive --agree-tos -m admin@$DOMAIN || \
  echo "Certbot failed. Check DNS, then rerun: certbot --nginx -d $DOMAIN -d www.$DOMAIN"
echo "Done: https://$DOMAIN"
