#!/bin/bash
set -euo pipefail

# ═══════════════════════════════════════════════
# Agri-Bridge VPS Setup — One-shot provisioning
# ═══════════════════════════════════════════════
#
# Usage:
#   ssh root@your-vps
#   git clone <repo> /opt/agribis && cd /opt/agribis
#   chmod +x scripts/vps-setup.sh
#   sudo scripts/vps-setup.sh --domain agribridge.example.com --email admin@example.com
#
# What it does:
#   1. Installs Node 20, PM2, Nginx, Certbot, sqlite3
#   2. Creates non-root 'agribis' system user
#   3. Installs dependencies
#   4. Prompts for .env config
#   5. Seeds the database
#   6. Starts PM2 + enables boot startup
#   7. Configures Nginx reverse proxy
#   8. Obtains Let's Encrypt HTTPS cert
#   9. Sets up SQLite backup cron (every 6h)
#   10. Enables UFW firewall

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[SETUP]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ── Parse args ──
DOMAIN=""
EMAIL=""
SKIP_SSL=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --domain) DOMAIN="$2"; shift 2;;
        --email) EMAIL="$2"; shift 2;;
        --skip-ssl) SKIP_SSL=true; shift;;
        *) err "Unknown arg: $1. Usage: sudo ./vps-setup.sh --domain example.com --email you@example.com";;
    esac
done

[[ -z "$DOMAIN" ]] && err "Missing --domain. Usage: sudo ./vps-setup.sh --domain agribridge.example.com --email admin@example.com"
[[ -z "$EMAIL" ]] && EMAIL="admin@${DOMAIN}"

# ── Must be root ──
[[ $EUID -ne 0 ]] && err "Run with sudo: sudo scripts/vps-setup.sh --domain $DOMAIN"

APP_DIR="/opt/agribis"
DATA_DIR="/opt/agribis/data"
BACKUP_DIR="/backups/agribis"
LOG_DIR="/opt/agribis/logs"

# ═══════════════════════════════════════════════
# 1. System packages
# ═══════════════════════════════════════════════
log "Installing system packages..."
apt-get update -qq
apt-get install -y -qq curl gnupg sqlite3 nginx certbot python3-certbot-nginx ufw

# Node 20 LTS
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 20 ]]; then
    log "Installing Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
fi

# Build tools for better-sqlite3
apt-get install -y -qq python3 make g++

# PM2
if ! command -v pm2 &>/dev/null; then
    log "Installing PM2..."
    npm install -g pm2
fi

log "Node $(node -v) | npm $(npm -v) | PM2 $(pm2 -v)"

# ═══════════════════════════════════════════════
# 2. App user + directories
# ═══════════════════════════════════════════════
if ! id -u agribis &>/dev/null; then
    log "Creating system user 'agribis'..."
    useradd -r -m -s /bin/bash agribis
fi

mkdir -p "$DATA_DIR" "$LOG_DIR" "$BACKUP_DIR" "$APP_DIR/uploads"
chown -R agribis:agribis "$APP_DIR" "$BACKUP_DIR"

# ═══════════════════════════════════════════════
# 3. Install dependencies
# ═══════════════════════════════════════════════
log "Installing npm dependencies..."
cd "$APP_DIR"
sudo -u agribis npm ci --omit=dev

# ═══════════════════════════════════════════════
# 4. Configure .env
# ═══════════════════════════════════════════════
ENV_FILE="$APP_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
    log "Creating .env from template..."
    ADMIN_SECRET=$(openssl rand -hex 32)

    cat > "$ENV_FILE" << ENVEOF
PORT=3000
NODE_ENV=production
DB_PATH=$DATA_DIR/agribis.db
ADMIN_SECRET=$ADMIN_SECRET
AT_API_KEY=
AT_USERNAME=sandbox
AT_SENDER_ID=AgriBridge
SANDBOX=true
SEED_DEMO=true
DISCORD_WEBHOOK_URL=
ENVEOF

    chown agribis:agribis "$ENV_FILE"
    chmod 600 "$ENV_FILE"

    log "Generated ADMIN_SECRET: $ADMIN_SECRET"
    warn "Save this secret! You'll need it for the admin panel."
    warn "Edit $ENV_FILE to add your Africa's Talking API key and Discord webhook."
else
    log ".env already exists — skipping"
fi

# ═══════════════════════════════════════════════
# 5. Seed database
# ═══════════════════════════════════════════════
log "Seeding database..."
sudo -u agribis node scripts/seed.js

# ═══════════════════════════════════════════════
# 6. PM2 startup
# ═══════════════════════════════════════════════
log "Starting app with PM2..."
sudo -u agribis pm2 start ecosystem.config.js
sudo -u agribis pm2 save

# PM2 boot startup (run as agribis user)
env PATH=$PATH:/usr/bin pm2 startup systemd -u agribis --hp /home/agribis
sudo -u agribis pm2 save

# Verify it's alive
sleep 2
if curl -sf http://localhost:3000/api/prices > /dev/null; then
    log "App is running on port 3000"
else
    err "App failed to start! Check: sudo -u agribis pm2 logs agribis"
fi

# ═══════════════════════════════════════════════
# 7. Nginx reverse proxy
# ═══════════════════════════════════════════════
log "Configuring Nginx for $DOMAIN..."
cat > /etc/nginx/sites-available/agribis << NGINXEOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        client_max_body_size 50M;
    }
}
NGINXEOF

ln -sf /etc/nginx/sites-available/agribis /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
log "Nginx configured — http://$DOMAIN proxies to :3000"

# ═══════════════════════════════════════════════
# 8. HTTPS (Let's Encrypt)
# ═══════════════════════════════════════════════
if [[ "$SKIP_SSL" = false ]]; then
    log "Obtaining SSL certificate for $DOMAIN..."
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect
    log "HTTPS enabled — https://$DOMAIN"
else
    warn "SSL skipped (--skip-ssl). Run manually: sudo certbot --nginx -d $DOMAIN"
fi

# ═══════════════════════════════════════════════
# 9. SQLite backup cron (every 6 hours)
# ═══════════════════════════════════════════════
log "Setting up database backups..."

BACKUP_SCRIPT="$APP_DIR/scripts/backup.sh"
cat > "$BACKUP_SCRIPT" << 'BACKUPEOF'
#!/bin/bash
DB_PATH="/opt/agribis/data/agribis.db"
BACKUP_DIR="/backups/agribis"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/agribis_$TIMESTAMP.db"

# SQLite safe backup (works even during writes)
sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"

# Keep only last 14 backups (3.5 days at 6h intervals)
ls -t "$BACKUP_DIR"/agribis_*.db 2>/dev/null | tail -n +15 | xargs rm -f 2>/dev/null

echo "[$(date)] Backup: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))" >> "$BACKUP_DIR/backup.log"
BACKUPEOF

chmod +x "$BACKUP_SCRIPT"
chown agribis:agribis "$BACKUP_SCRIPT"

# Add cron for agribis user
CRON_LINE="0 */6 * * * $BACKUP_SCRIPT"
(sudo -u agribis crontab -l 2>/dev/null | grep -v backup.sh; echo "$CRON_LINE") | sudo -u agribis crontab -
log "Backup cron installed — every 6 hours, keeps last 14"

# Run first backup now
sudo -u agribis "$BACKUP_SCRIPT"
log "First backup created at $BACKUP_DIR/"

# ═══════════════════════════════════════════════
# 10. Firewall
# ═══════════════════════════════════════════════
log "Configuring firewall..."
ufw --force reset > /dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
log "Firewall active — SSH + Nginx only"

# ═══════════════════════════════════════════════
# DONE
# ═══════════════════════════════════════════════
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo -e "${GREEN} Agri-Bridge is LIVE${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo ""
echo "  URL:        https://$DOMAIN"
echo "  Admin:      https://$DOMAIN/app/admin.html"
echo "  Buyer:      https://$DOMAIN/app/buyer.html"
echo "  Agent:      https://$DOMAIN/app/agent-pro.html"
echo ""
echo "  PM2:        sudo -u agribis pm2 status"
echo "  Logs:       sudo -u agribis pm2 logs agribis"
echo "  Backups:    ls -lh $BACKUP_DIR/"
echo ""
echo -e "${YELLOW}  ADMIN_SECRET is in $ENV_FILE${NC}"
echo ""
echo "  Demo credentials:"
echo "    Agents:  +256770001001..003  PIN: 5678"
echo "    Buyers:  +256780001001..002  PIN: 9999"
echo "    Farmers: +256701000001..006  PIN: 1234"
echo ""
echo -e "${GREEN}  Pilot exit criteria:${NC}"
echo "    1. >= 3/5 agents complete full escrow cycle"
echo "    2. Zero data corruption"
echo "    3. >= 2 buyer RELEASE confirmations"
echo "    4. USSD completion rate > 70%"
echo "    5. Avg time-to-release < 24h"
echo ""
