# Agri-Bridge VPS Deployment Runbook

**Purpose:** Deploy the Micro-Aggregator OS for the Beta 5 Pilot.
**Target:** Ubuntu 22.04+ VPS ($5 tier — 1 vCPU, 1GB RAM, 25GB disk).
**Providers tested against:** DigitalOcean, Hetzner, Railway (any provider works).

---

## Prerequisites

- A domain name pointed to the VPS IP (e.g., `agribridge.example.com`)
- SSH access to the VPS as a non-root sudo user
- The repo cloned or pushed to the server

---

## 1. Server Setup (one-time)

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install build tools for better-sqlite3
sudo apt install -y python3 make g++

# Install PM2 globally
sudo npm install -g pm2

# Install Nginx + Certbot
sudo apt install -y nginx certbot python3-certbot-nginx

# Create app directory
sudo mkdir -p /opt/agribis
sudo chown $USER:$USER /opt/agribis
```

## 2. Deploy the App

```bash
# Clone or copy the repo
cd /opt/agribis
git clone <your-repo-url> .
# OR: scp -r ./agribis/* user@vps:/opt/agribis/

# Install production dependencies
npm ci --omit=dev

# Create .env from template
cp .env.example .env
nano .env
```

### Required .env values for pilot:

```env
PORT=3000
NODE_ENV=production
DB_PATH=/opt/agribis/data/agribis.db
ADMIN_SECRET=<generate-a-strong-secret>
AT_API_KEY=<your-africastalking-key>
AT_USERNAME=<your-africastalking-username>
AT_SENDER_ID=AgriBridge
SANDBOX=true
SEED_DEMO=true
DISCORD_WEBHOOK_URL=<your-discord-webhook-url>
```

Generate the admin secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Create data + logs directories:

```bash
mkdir -p /opt/agribis/data /opt/agribis/logs /opt/agribis/uploads
```

### Seed the database:

```bash
# First run seeds automatically if SEED_DEMO=true, or manually:
npm run seed
```

## 3. PM2 Setup

```bash
cd /opt/agribis

# Start the app
pm2 start ecosystem.config.js

# Verify it's running
pm2 status
pm2 logs agribis --lines 20

# Save PM2 process list (survives reboot)
pm2 save

# Enable PM2 startup on boot
pm2 startup
# (Run the command it prints — it'll look like: sudo env PATH=... pm2 startup ...)
```

### PM2 cheat sheet:

```bash
pm2 restart agribis      # Restart after code update
pm2 logs agribis          # Tail logs
pm2 monit                 # Live CPU/memory monitor
pm2 reload agribis        # Zero-downtime reload
```

## 4. Nginx Reverse Proxy

```bash
sudo nano /etc/nginx/sites-available/agribis
```

Paste this config (replace `agribridge.example.com` with your domain):

```nginx
server {
    listen 80;
    server_name agribridge.example.com;

    # Redirect all HTTP to HTTPS (Certbot will handle this after setup)
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # File upload limit (for warehouse receipt photos + videos)
        client_max_body_size 50M;
    }
}
```

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/agribis /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

## 5. HTTPS with Let's Encrypt

```bash
sudo certbot --nginx -d agribridge.example.com
```

Certbot will:
- Obtain a free SSL certificate
- Auto-configure Nginx for HTTPS
- Set up auto-renewal (cron runs twice daily)

Verify auto-renewal works:
```bash
sudo certbot renew --dry-run
```

## 6. SQLite Backup (Critical)

The SQLite database file IS the business. One corrupt file = lost escrow states.

### Option A: Local backup to a separate volume (simplest)

```bash
# Create backup directory (ideally a separate mounted volume)
sudo mkdir -p /backups/agribis
sudo chown $USER:$USER /backups/agribis
```

Create the backup script:

```bash
cat > /opt/agribis/scripts/backup.sh << 'BACKUP'
#!/bin/bash
# Agri-Bridge SQLite Backup
# Uses .backup command for safe copy (not raw cp — avoids WAL corruption)

DB_PATH="/opt/agribis/data/agribis.db"
BACKUP_DIR="/backups/agribis"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/agribis_$TIMESTAMP.db"

# SQLite safe backup (works even during writes)
sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"

# Keep only last 14 backups (3.5 days at 6h intervals)
ls -t "$BACKUP_DIR"/agribis_*.db 2>/dev/null | tail -n +15 | xargs rm -f 2>/dev/null

# Log it
echo "[$(date)] Backup: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))" >> "$BACKUP_DIR/backup.log"
BACKUP

chmod +x /opt/agribis/scripts/backup.sh
```

Install sqlite3 CLI for safe backups:
```bash
sudo apt install -y sqlite3
```

Schedule every 6 hours:
```bash
crontab -e
```

Add this line:
```cron
0 */6 * * * /opt/agribis/scripts/backup.sh
```

### Option B: Offsite to S3 (add after local backup is confirmed working)

```bash
# Install AWS CLI
sudo apt install -y awscli

# Configure with a restricted IAM user (PutObject only)
aws configure
```

Extend the backup script — add after the sqlite3 .backup line:

```bash
aws s3 cp "$BACKUP_FILE" "s3://your-bucket/agribis-backups/$TIMESTAMP.db" --quiet
```

### Verify backups work:

```bash
# Run manually once
/opt/agribis/scripts/backup.sh

# Check the backup is valid
sqlite3 /backups/agribis/agribis_*.db "SELECT COUNT(*) FROM agents;"
```

## 7. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

This blocks direct access to port 3000 — all traffic goes through Nginx/HTTPS.

## 8. Code Updates During Pilot

When pushing a patch (copy fix, crash fix, UX tweak):

```bash
cd /opt/agribis
git pull origin master
npm ci --omit=dev        # Only if package.json changed
pm2 reload agribis       # Zero-downtime reload
```

## 9. Monitoring Checklist

### Discord alerts (automatic)
- Escrow created, disputes filed, errors — all push to the configured webhook

### Daily ops check (manual, 2 minutes)
```bash
# Is the app alive?
pm2 status

# Any errors in the last 24h?
pm2 logs agribis --err --lines 50

# Disk usage (25GB box — watch it)
df -h /

# Database size
du -h /opt/agribis/data/agribis.db

# Recent backups
ls -lh /backups/agribis/ | tail -5

# Request volume
curl -s -H "x-admin-secret: $ADMIN_SECRET" \
  https://agribridge.example.com/api/admin/request-log?limit=10 | node -e "
    const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.log(d.length+' recent requests');
    d.slice(0,5).forEach(r=>console.log(r.method,r.path,r.status_code,r.duration_ms+'ms'));
  "
```

### Admin panel
Browse to `https://agribridge.example.com/app/admin.html` and check:
- **Overview** — escrow counts, revenue, active agents
- **Arbitration** — any disputes or stale escrows?
- **Payouts** — pending disbursements
- **Agents** — trust tiers, any needing suspension?
- **Activity** — request patterns, error spikes

---

## 10. Pilot Exit Criteria

The pilot succeeds when ALL of these are met:

| # | Metric | Target | How to Measure |
|---|--------|--------|----------------|
| 1 | Agents completing full escrow cycle | >= 3 of 5 | Admin panel → Overview |
| 2 | Data corruption incidents | 0 | Backup integrity checks + error logs |
| 3 | Buyer RELEASE confirmations | >= 2 | Activity log: POST /api/escrow/:id/release |
| 4 | USSD session completion rate | > 70% | Activity log: filter type=USSD, check for END responses |
| 5 | Average time-to-release | < 24h | Escrow timestamps: released_at - dispatched_at |

Once all 5 hit — even if it's day 3 — we're cleared for Layer 4.

---

## Rollback

If something goes catastrophically wrong:

```bash
# Stop the app
pm2 stop agribis

# Restore from last good backup
cp /backups/agribis/agribis_LATEST.db /opt/agribis/data/agribis.db

# Restart
pm2 start agribis
```

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| 502 Bad Gateway | `pm2 status` — is the app running? Check `pm2 logs agribis --err` |
| SSL warning in browser | `sudo certbot renew` — is the cert expired? |
| Database locked errors | Only one PM2 instance should run (fork mode, not cluster) |
| Uploads failing | Check disk space (`df -h`), check `/opt/agribis/uploads` permissions |
| SMS not sending | Check AT_API_KEY in .env, verify Africa's Talking dashboard |
| USSD not working | Africa's Talking callback URL must point to `https://domain/ussd` |
