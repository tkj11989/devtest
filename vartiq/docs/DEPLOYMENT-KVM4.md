# Deploying VartiQ on the KVM 4 server that already runs ExamSuit

**Read this first.** ExamSuit is live on this server. Everything below is built so that VartiQ is added *next to* ExamSuit without touching it: its own system user, its own folders, its own database, its own web-server file, its own ports, hard CPU and memory limits, and a one-command way to switch VartiQ off again. Nothing here edits an ExamSuit file, restarts ExamSuit, or reloads anything but a *tested* nginx configuration.

Assumptions (check them in Phase 0): Hostinger KVM 4 (about 4 vCPU, 16 GB RAM, 200 GB NVMe, public IPv4), Ubuntu or Debian, **no Cloudflare for now** (Let's Encrypt certificates; Cloudflare can be added later, see the end of Phase 6), ExamSuit served by nginx. Where ExamSuit uses something else (Apache, Docker, a different database) the guide says what to change.

> **Rules while you do this**
> 1. Work in a quiet period for ExamSuit (no exams, no sign-up rush).
> 2. Take the snapshot in Phase 1 first. Do not skip it.
> 3. After every phase run the **ExamSuit check** (box below). If it looks worse than before, stop and use the rollback at the end.
> 4. Never run `apt upgrade`, restart nginx (use `reload`), or change global PostgreSQL or kernel settings as part of this guide.

> **ExamSuit check** (run before you start, and after each phase)
> ```bash
> curl -s -o /dev/null -w "ExamSuit: HTTP %{http_code} in %{time_total}s\n" https://YOUR-EXAMSUIT-DOMAIN/
> free -h | head -2; uptime
> ```
> Write down the "before" numbers.

---

## 0. What you are building

```
 People ──► vartiq.prayuktech.com (DNS A record straight to this server, HTTPS from Let's Encrypt)
                │
          nginx on the server  ── ExamSuit's own site files stay as they are
                │  127.0.0.1:3100
                ▼
          VartiQ (Node.js, systemd service, limited to ~4 GB RAM / 1.5 CPU)
                │
                ├──► PostgreSQL (database "vartiq", only reachable from this machine)
                └──► /var/lib/vartiq/media (voice notes, status photos, product pictures)

 Calls, when phones cannot connect directly:
 People ──► turn.prayuktech.com ──► coturn on UDP/TCP 3478
```

Sizes to plan with (my estimates, not measurements on your server): VartiQ about 1 GB of RAM and one CPU core at 10,000 connected people; coturn a few hundred MB plus network bandwidth; PostgreSQL a few hundred MB. Together roughly 2.5 to 4 GB of the 16 GB, **if ExamSuit leaves that room**. Phase 0 tells you whether it does.

---

## Phase 0. Look before you touch (read-only)

Run these as an admin user. They change nothing. Paste the output into a note: you need it in the next phases.

```bash
cat /etc/os-release | head -3; nproc; free -h; df -h /
sudo ss -tlnp            # what listens on which port (look for 80, 443, 3000, 3478, 5432, 3306)
sudo ss -ulnp            # UDP (look for 3478)
systemctl list-units --type=service --state=running --no-pager | head -40
sudo nginx -v; sudo nginx -T 2>/dev/null | grep -E "server_name|listen|include|conf.d|sites-enabled" | head -40
which psql mysql mariadb docker 2>/dev/null; sudo systemctl is-active postgresql mysql mariadb docker 2>/dev/null
sudo ufw status verbose 2>/dev/null; sudo iptables -S 2>/dev/null | head -20
node -v 2>/dev/null; ls /etc/letsencrypt/live 2>/dev/null
top -b -n1 | head -15
```

Fill in this table:

| Question | Your answer | What it changes |
| --- | --- | --- |
| Web server in front of ExamSuit | nginx / Apache / other | This guide uses nginx. For Apache or Traefik/Docker, see the note in Phase 5. |
| Does anything already use port 3000? | yes / no | If yes, set `PORT=3100` everywhere below. |
| Is anything listening on 3478 (UDP or TCP)? | yes / no | If yes, ExamSuit already runs a TURN or STUN server: stop and tell your team before Phase 7. |
| Database used by ExamSuit | PostgreSQL / MySQL / none | PostgreSQL: Option A or B in Phase 4. MySQL or none: Option C. |
| Free RAM at a busy time (`free -h`, "available") | ___ GB | Need at least about 4 GB free. If less, **stop**: upgrade the plan or move VartiQ to its own server. |
| CPU load at a busy time (`uptime`, 15-minute number) | ___ | If it is already above 3.0 on 4 cores, **stop** for the same reason. |
| Free disk | ___ GB | Plan about 10 GB for the first months (see "How much space" below). |
| Firewall: ufw / Hostinger panel firewall / none | ___ | Phase 8 opens a few ports in whichever you use. |
| Node.js used by ExamSuit and its version | ___ | VartiQ gets its own Node 22 (Phase 3), so ExamSuit's is never changed. |

**Stop here if** RAM or CPU is already tight, or if something already uses 3478. Fix that first.

### Your server, as checked on 2026-10-15

| Item | Result | Decision |
| --- | --- | --- |
| System | Ubuntu 24.04.5, 4 cores, 15 GB RAM (14 GB available), 172 GB free, load about 0.05 | Room for VartiQ. No stop condition. |
| ExamSuit | Next.js 14.2.5 under PM2 as root, `127.0.0.1`/`*:3000`, system Node 20.20.2 | VartiQ uses **`PORT=3100`** (not 3000) and its own Node 22 in `/opt/node22`. |
| Free ports | 3100, 5433, 3478 (TCP and UDP) free | As planned. |
| nginx 1.24 | One site `sites-enabled/examsuit` (Certbot certificate), `conf.d/` empty, no `default_server` | VartiQ goes in **`sites-enabled/vartiq`**, so ExamSuit's file is read first and stays the default site (6.2). |
| PostgreSQL 16 | One cluster on 5432, `max_connections=100`, 11 in use. ExamSuit's log shows a past PostgreSQL restart cut its connections | **Option B** (own cluster on 5433): a restart or tuning of VartiQ's database can never touch ExamSuit's. |
| Traefik container | Restarts every minute: it cannot bind port 80 because nginx holds it | Leave it alone, but **never `systemctl stop nginx`**: Traefik would take ports 80/443. Only `nginx -t && systemctl reload nginx`. |
| Cloudflare | Not used (`examsuit.com` is served directly, and you confirmed `prayuktech.com` is not on it) | Let's Encrypt certificates and nginx protections instead (Phase 2 and 6). |
| Firewall | ufw: 22, 80, 443 only; Docker present | Phase 8 adds only what calls need (3478 and a relay range). |
| Backups | No cron backup of ExamSuit's database or files exists on this server | Not VartiQ's job, but take the Phase 1 snapshot, and consider a nightly `pg_dump examsuit` of your own. |
| ExamSuit warnings (not ours) | PM2 shows 18 restarts, 0 unstable; log has a Next.js "Failed to find Server Action" (stale browser tabs after a deploy) and an unknown `outputFileTracingRoot` option in `next.config.js` | Harmless today; mention to the ExamSuit team. |

---

## Phase 1. Safety net

1. **Snapshot or backup of the whole VPS** in Hostinger hPanel (VPS → Backups / Snapshots → create). Wait for it to finish. This is your complete undo.
2. **Copy ExamSuit's web server configuration** somewhere safe, read-only copy:
   ```bash
   sudo mkdir -p /root/pre-vartiq && sudo cp -a /etc/nginx /root/pre-vartiq/nginx
   sudo crontab -l > /root/pre-vartiq/root-crontab.txt 2>/dev/null || true
   ```
3. **Write down how to restart ExamSuit** (its systemd service or docker command) in case something unexpected happens. You will probably not need it.
4. **Tell your team** that a maintenance window is open and for how long.

---

## Phase 2. Domain names (no Cloudflare)

Add two `A` records at wherever `prayuktech.com`'s DNS is managed now (your registrar or Hostinger DNS), both pointing to this server's public IP (`AAAA` only if the server has IPv6 and you open it in the firewall):

| Name | Purpose |
| --- | --- |
| `vartiq.prayuktech.com` | the VartiQ web app, API and admin |
| `turn.prayuktech.com` | the call relay |

Use a short TTL (300) until everything works. Check from your own computer: `dig +short vartiq.prayuktech.com` and `dig +short turn.prayuktech.com` must both show the server IP before you ask for certificates in Phase 6. Do not touch the existing `examsuit.com` records.

Without Cloudflare, nothing sits in front of the server, so these protections matter more:
- nginx rate limits (Phase 6) and the app's own limits are the first line of defence against abuse. A large flood attack would take the whole server, ExamSuit included, so decide early whether to add Cloudflare (free plan) for `vartiq.prayuktech.com` later: the app needs no change, only DNS, the real-IP snippet in 6.4, and `TRUST_PROXY=1` stays.
- The admin dashboard is not published on the internet at all: nginx answers 404 for `/admin`, and you reach it through an SSH tunnel (6.2). No fixed IP address is needed.
- Hostinger's own network-level DDoS filtering applies to the server anyway; ask them what it covers.

---

## Phase 3. Create the user, folders and Node 22

VartiQ runs as its own user with its own Node.js, so nothing ExamSuit uses is changed.

```bash
# user and folders
sudo adduser --system --group --home /opt/vartiq --shell /usr/sbin/nologin vartiq
sudo mkdir -p /opt/vartiq/releases /var/lib/vartiq/media /etc/vartiq /var/backups/vartiq
sudo chown -R vartiq:vartiq /opt/vartiq /var/lib/vartiq
sudo chmod 750 /var/lib/vartiq /etc/vartiq

# Node 22 LTS in its own folder (does not touch the system Node)
cd /tmp
FILE=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep 'linux-x64.tar.xz' | awk '{print $2}')
curl -fsSLO "https://nodejs.org/dist/latest-v22.x/$FILE"
curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep " $FILE\$" | sha256sum -c -
sudo mkdir -p /opt/node22 && sudo tar -xJf "$FILE" -C /opt/node22 --strip-components=1
/opt/node22/bin/node -v          # v22.x.x
```

---

## Phase 4. The database

VartiQ needs PostgreSQL. Pick **one** option.

### Option A: ExamSuit already uses PostgreSQL (share the server, separate database)

Only add a new role and database. Do not change any global setting.

```bash
sudo -u postgres psql -c "SHOW max_connections;" -c "SELECT count(*) FROM pg_stat_activity;"
# VartiQ uses at most 4 connections per process. If max_connections - current is under 30, use Option B.
PW=$(openssl rand -base64 24 | tr -d '/+=')
echo "Database password (save it): $PW"
sudo -u postgres psql <<SQL
CREATE ROLE vartiq LOGIN PASSWORD '$PW' CONNECTION LIMIT 20;
CREATE DATABASE vartiq OWNER vartiq ENCODING 'UTF8';
SQL
```

The connection string is `postgres://vartiq:PASSWORD@127.0.0.1:5432/vartiq`. Confirm that `pg_hba.conf` has a rule for local TCP connections with a password (`host all all 127.0.0.1/32 scram-sha-256`); on a standard install it does. Do not change ExamSuit's lines.

### Option B: a separate PostgreSQL cluster on its own port (safest for ExamSuit; **use this on your server**)

Ubuntu and Debian can run several clusters side by side:

```bash
sudo apt-get install -y postgresql postgresql-common       # skip if already installed
sudo pg_createcluster 16 vartiq --port=5433 --start        # use your installed major version
sudo -u postgres psql -p 5433 <<SQL
CREATE ROLE vartiq LOGIN PASSWORD 'PUT-A-LONG-RANDOM-PASSWORD-HERE';
CREATE DATABASE vartiq OWNER vartiq ENCODING 'UTF8';
SQL
```

It listens on `127.0.0.1:5433` only. Connection string: `postgres://vartiq:PASSWORD@127.0.0.1:5433/vartiq`. Optional tuning for this cluster only (`/etc/postgresql/16/vartiq/postgresql.conf`): `shared_buffers = 512MB`, `max_connections = 40`, then `sudo pg_ctlcluster 16 vartiq restart`.

### Option C: ExamSuit uses MySQL or no database

Install PostgreSQL normally (`sudo apt-get install -y postgresql`) and create the role and database as in Option A (port 5432). This does not affect MySQL.

Whichever option you chose, check that it is **not reachable from outside**: `sudo ss -tlnp | grep -E "5432|5433"` must show `127.0.0.1`, never `0.0.0.0`.

---

## Phase 5. Install VartiQ

### 5.1 Get the code

The VartiQ app is the `vartiq/` folder of the `tkj11989/devtest` repository (branch `ccr-05be35cc-0g7vsg` until you merge it). Use a read-only deploy key on GitHub for the server.

```bash
sudo apt-get install -y git rsync curl                 # skip what is already installed
sudo -u vartiq -H mkdir -p /opt/vartiq/.ssh
sudo -u vartiq -H ssh-keygen -t ed25519 -N '' -f /opt/vartiq/.ssh/id_ed25519
sudo cat /opt/vartiq/.ssh/id_ed25519.pub     # add this as a read-only "Deploy key" in the GitHub repository settings
sudo -u vartiq -H ssh-keyscan github.com >> /opt/vartiq/.ssh/known_hosts
sudo -u vartiq -H git clone --branch ccr-05be35cc-0g7vsg --depth 1 git@github.com:tkj11989/devtest.git /opt/vartiq/src
```

### 5.2 Release script (also used for every later update)

Save as `/usr/local/bin/vartiq-deploy` (`sudo chmod +x`). It builds a new release folder, switches the `current` link, restarts, checks health, and **rolls back by itself** if the check fails.

```bash
#!/usr/bin/env bash
# usage: vartiq-deploy [branch]
set -euo pipefail
BRANCH="${1:-ccr-05be35cc-0g7vsg}"
NODE=/opt/node22/bin
export PATH="$NODE:$PATH"
cd /opt/vartiq/src
sudo -u vartiq git fetch --depth 1 origin "$BRANCH"
sudo -u vartiq git checkout -q FETCH_HEAD
REL=/opt/vartiq/releases/$(date +%Y%m%d-%H%M%S)
sudo -u vartiq mkdir -p "$REL"
sudo -u vartiq rsync -a --exclude node_modules --exclude data /opt/vartiq/src/vartiq/ "$REL"/
cd "$REL" && sudo -u vartiq env PATH="$PATH" npm ci --omit=dev --no-audit --no-fund
PREV=$(readlink -f /opt/vartiq/current || true)
sudo -u vartiq ln -sfn "$REL" /opt/vartiq/current
sudo systemctl restart vartiq
sleep 3
if curl -fsS http://127.0.0.1:3100/api/v1/config >/dev/null; then
  echo "OK: running $REL"
  ls -dt /opt/vartiq/releases/* | tail -n +6 | xargs -r sudo rm -rf   # keep the last 5
else
  echo "FAILED: rolling back to $PREV"
  [ -n "$PREV" ] && sudo -u vartiq ln -sfn "$PREV" /opt/vartiq/current && sudo systemctl restart vartiq
  exit 1
fi
```

You can run the app's tests on your own computer or CI before you deploy: `npm test`. There is no need to install dev packages on the server.

### 5.3 Configuration file

Create `/etc/vartiq/vartiq.env` (owner root, group vartiq, mode `640`). **Every secret is yours to generate**; `openssl rand -base64 32` is fine.

```bash
# ---- where it listens (only nginx on this machine may reach it)
HOST=127.0.0.1
PORT=3100                 # 3000 is ExamSuit
TRUST_PROXY=loopback            # the real visitor address comes from nginx; without this every visitor shares one rate limit

# ---- data
DATABASE_URL=postgres://vartiq:PASSWORD@127.0.0.1:5433/vartiq     # Option B (5432 only for Option A or C)
MEDIA_DIR=/var/lib/vartiq/media
CORS_ORIGINS=https://vartiq.prayuktech.com

# ---- administrator (created or updated at every start; use 16+ random characters)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=CHANGE-ME-LONG-RANDOM

# ---- who is responsible (printed in the Terms and Privacy Notice; also editable in Admin -> Settings -> Legal)
LEGAL_COMPANY=Your Company Legal Name
LEGAL_ADDRESS=Registered address
LEGAL_CONTACT_EMAIL=hello@prayuktech.com
LEGAL_GRIEVANCE_NAME=Grievance Officer name
LEGAL_GRIEVANCE_EMAIL=grievance@prayuktech.com
LEGAL_CITY=City for courts
LEGAL_HOSTING=India (your data centre location)

# ---- calls (Phase 7): short-lived credentials for your own TURN server
TURN_URLS=turn:turn.prayuktech.com:3478?transport=udp,turn:turn.prayuktech.com:3478?transport=tcp,turns:turn.prayuktech.com:5349?transport=tcp   # last one: after 7.2
TURN_SECRET=THE-SAME-SECRET-AS-IN-coturn
TURN_TTL_SECONDS=86400

# ---- the public address of the app. Links sent to parents and guardians of under-18 users are built on it (required: without it
# a child cannot register on a public server).
PUBLIC_URL=https://vartiq.prayuktech.com

# ---- push notifications (messages and calls when the app is closed). Make the pair once (Phase 5.3a) and keep it: if it
# changes, every device must turn notifications on again. PUSH_SUBJECT identifies you to the browsers' push services.
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
PUSH_SUBJECT=mailto:hello@prayuktech.com

# ---- real providers (each is a small relay you control; see README). Leave a line out to leave that feature OFF
OTP_WEBHOOK_URL=https://...
OTP_WEBHOOK_TOKEN=...
KYC_WEBHOOK_URL=https://...
KYC_WEBHOOK_TOKEN=...
# Razorpay (payments): keys from Dashboard, Account & Settings, API keys. Use rzp_test_ keys first.
RAZORPAY_KEY_ID=rzp_live_xxxxxxxx
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...      # the secret you type when you add the webhook in the Razorpay Dashboard
PLAN_CURRENCY=INR
TRANSLATE_WEBHOOK_URL=https://...
TRANSLATE_WEBHOOK_TOKEN=...

# ---- account deletion: how long after the request the data is erased (never more than 24 hours)
ACCOUNT_ERASE_DELAY_MS=3600000
```

**Must NOT appear in this file in production:** `OTP_DEV_CODES`, `KYC_SANDBOX`, `PAYMENTS_SANDBOX`, `TRANSLATE_SANDBOX`, `WEBHOOKS_ALLOW_PRIVATE`. The sandbox switches give away verification and Premium, and `OTP_DEV_CODES` shows login codes on screen. Check: `grep -E "SANDBOX|DEV_CODES" /etc/vartiq/vartiq.env` must print nothing.

Without `OTP_WEBHOOK_URL` login codes are only printed in the server log and nobody receives an SMS, so real sign-up does not work until it is set.

### 5.3a Push notification keys

Make the key pair once, after the first release is installed (Phase 5.2), and paste the two lines into `/etc/vartiq/vartiq.env`:

```bash
sudo -u vartiq /opt/node22/bin/node -e "const k=require('/opt/vartiq/current/node_modules/web-push').generateVAPIDKeys();console.log('VAPID_PUBLIC_KEY='+k.publicKey);console.log('VAPID_PRIVATE_KEY='+k.privateKey)"
```

Leave them out and VartiQ makes a pair on first start and keeps it in `/var/lib/vartiq/vapid.json` (it is in the backup below). Either way, **keep a copy**: they are secrets, and the same pair must stay in place across servers and restores. Notifications need the server to reach the browsers' push services over HTTPS (outbound port 443, which ufw allows by default on your server); no inbound port is needed.

### 5.4 The service

`/etc/systemd/system/vartiq.service`:

```ini
[Unit]
Description=VartiQ messenger
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=vartiq
Group=vartiq
WorkingDirectory=/opt/vartiq/current
EnvironmentFile=/etc/vartiq/vartiq.env
ExecStart=/opt/node22/bin/node --max-old-space-size=3072 server/index.js
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
KillSignal=SIGTERM

# So VartiQ can never starve ExamSuit
MemoryHigh=3500M
MemoryMax=4G
CPUQuota=150%
Nice=10
TasksMax=512
LimitNOFILE=65536

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/vartiq
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
```

`TimeoutStopSec=30` gives the app time to save everything to PostgreSQL when it is stopped (it does on `SIGTERM`). Start it (nothing is public yet):

```bash
sudo systemctl daemon-reload
sudo vartiq-deploy                       # first release; builds /opt/vartiq/current
sudo systemctl enable vartiq
sudo journalctl -u vartiq -n 30 --no-pager
# expect: "VartiQ running at http://127.0.0.1:3100" and "Data: PostgreSQL"
curl -s http://127.0.0.1:3100/api/v1/config | head -c 200
```

(The first `vartiq-deploy` run restarts the service before it exists as enabled; that is fine. If it reports failure, read the journal.)

Run the **ExamSuit check**.

---

## Phase 6. nginx: one new file, tested before it is loaded

Use a **separate file**. Never edit ExamSuit's. Names starting with `vq_` avoid clashing with anything ExamSuit already defines (a duplicate `map` or `limit_req_zone` name would make `nginx -t` fail, which is exactly why you test first).

### 6.2 The site

Create it as `/etc/nginx/sites-available/vartiq` and enable it with a link (6.3). nginx reads `conf.d/` *before* `sites-enabled/`, and the first server block for a port answers requests for unknown names. A file in `conf.d/` would therefore become the default site and take over ExamSuit's role; `sites-enabled/vartiq` sorts after `examsuit`, so ExamSuit stays the default.

Do **not** use `certbot --nginx`: it rewrites nginx files. Certificates are requested with `certonly --webroot`, so nothing of ExamSuit's is changed. Because a certificate cannot exist before nginx answers the Let's Encrypt check, you do this in **two steps**.

**Step 1 (HTTP only).** Put only this in `/etc/nginx/sites-available/vartiq`, then run 6.3 and the certificate commands below:

```nginx
server {
    listen 80;
    server_name vartiq.prayuktech.com turn.prayuktech.com;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://vartiq.prayuktech.com$request_uri; }
}
```

```bash
sudo mkdir -p /var/www/html/.well-known/acme-challenge
sudo certbot certonly --webroot -w /var/www/html -d vartiq.prayuktech.com
sudo certbot certonly --webroot -w /var/www/html -d turn.prayuktech.com   # used in 7.2
```

Certbot's renewal timer already exists on this server and renews these too. If it fails, the usual causes are the DNS records not pointing here yet, or port 80 blocked; nothing was changed for ExamSuit.

**Step 2 (the full site).** Replace the file with the following and run 6.3 again:

```nginx
# WebSocket upgrade (names are unique to VartiQ)
map $http_upgrade $vq_connection_upgrade { default upgrade; '' close; }

# Gentle limit on sign-in style calls; ExamSuit is not affected (own zone)
limit_req_zone $binary_remote_addr zone=vq_auth:10m rate=10r/s;

server {
    listen 80;
    server_name vartiq.prayuktech.com turn.prayuktech.com;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://vartiq.prayuktech.com$request_uri; }
}

server {
    listen 443 ssl;
    server_name vartiq.prayuktech.com;
    # nginx 1.25.1 or newer: add the line  http2 on;  (older versions: write  listen 443 ssl http2;  above instead)

    ssl_certificate     /etc/letsencrypt/live/vartiq.prayuktech.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/vartiq.prayuktech.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    # (Cloudflare real-IP include: only if you add Cloudflare later, see 6.4)

    client_max_body_size 5m;                 # voice notes and photos are small
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header Strict-Transport-Security "max-age=31536000" always;

    # Admin dashboard and its API: NOT reachable from the internet at all.
    # You open it through an SSH tunnel (see "Opening the admin dashboard" below).
    location /admin { return 404; }

    location /api/v1/auth/ {
        limit_req zone=vq_auth burst=30 nodelay;
        proxy_pass http://127.0.0.1:3100;
        include /etc/nginx/snippets/vartiq-proxy.conf;
    }

    location / {
        proxy_pass http://127.0.0.1:3100;
        include /etc/nginx/snippets/vartiq-proxy.conf;
    }
}
```

`/etc/nginx/snippets/vartiq-proxy.conf`:

```nginx
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $remote_addr;      # $remote_addr is the real visitor after the real_ip step
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $vq_connection_upgrade;
proxy_read_timeout 3600s;                            # long-lived WebSocket connections
proxy_send_timeout 3600s;
proxy_buffering off;
```

**Opening the admin dashboard (no fixed IP needed).** On your own computer run:

```bash
ssh -N -L 3100:127.0.0.1:3100 YOUR-USER@SERVER-IP
```

Leave it running and open `http://localhost:3100/admin` in your browser. The connection is encrypted by SSH, works from any network, and nobody else can even see the sign-in page. Use SSH keys (not passwords) for this, and keep `PasswordAuthentication no` in `sshd_config` once your key works. (If you prefer a plain URL, the alternative is nginx basic auth in front of `/admin`: `sudo apt-get install -y apache2-utils`, `sudo htpasswd -c /etc/nginx/vartiq.htpasswd YOURNAME`, then in the `location /admin` block use `auth_basic "VartiQ admin"; auth_basic_user_file /etc/nginx/vartiq.htpasswd;` plus the same `proxy_pass` lines as `location /`. It works from anywhere but the sign-in page is then visible to the internet behind a password, which is weaker than the tunnel.)

### 6.3 Test, then load. Never restart.

```bash
sudo ln -s /etc/nginx/sites-available/vartiq /etc/nginx/sites-enabled/vartiq
sudo nginx -t          # must say "syntax is ok" and "test is successful"
sudo systemctl reload nginx
```

If `nginx -t` fails, **do not reload**. Read the message (usually a duplicate name or a missing certificate), fix `sites-available/vartiq`, and test again. `reload` swaps the configuration without dropping ExamSuit's connections. If you cannot fix it quickly: `sudo rm /etc/nginx/sites-enabled/vartiq` and ExamSuit is exactly as before. (A failed test with the link in place only blocks *later* reloads, so remove the link first if you must leave it for a while.)

Run the **ExamSuit check**, then open `https://vartiq.prayuktech.com`. You should see the VartiQ sign-in page.

### 6.4 If you add Cloudflare later

In Cloudflare set SSL mode **Full (strict)**, proxy only `vartiq.prayuktech.com` (orange cloud; keep `turn.prayuktech.com` grey), turn off Rocket Loader and Auto Minify, and bypass cache for `/api/*`, `/socket.io/*`, `/admin/*`. Then add the real-visitor-address step so nginx and rate limits see people, not Cloudflare:

`/etc/nginx/snippets/vartiq-cloudflare-realip.conf` (a small script keeps it current), and put `include /etc/nginx/snippets/vartiq-cloudflare-realip.conf;` back into the `vartiq` 443 server block:

```bash
sudo tee /usr/local/bin/vartiq-update-cf-ips >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
OUT=/etc/nginx/snippets/vartiq-cloudflare-realip.conf
{
  echo "# generated $(date -u +%F) from cloudflare.com/ips"
  for u in https://www.cloudflare.com/ips-v4 https://www.cloudflare.com/ips-v6; do
    curl -fsS "$u" | sed 's/^/set_real_ip_from /; s/$/;/'
    echo
  done
  echo "real_ip_header CF-Connecting-IP;"
} > "$OUT.new"
mv "$OUT.new" "$OUT"
nginx -t && systemctl reload nginx
EOF
sudo chmod +x /usr/local/bin/vartiq-update-cf-ips
sudo mkdir -p /etc/nginx/snippets && sudo /usr/local/bin/vartiq-update-cf-ips
```


*If ExamSuit is not behind nginx:* Apache needs `mod_proxy`, `mod_proxy_wstunnel` and `ProxyPass "/socket.io/" "ws://127.0.0.1:3100/socket.io/"` plus `ProxyPass "/" "http://127.0.0.1:3100/"` and `ProxyPreserveHost On` in a new `VirtualHost` file; Docker/Traefik/Caddy users add a router for `vartiq.prayuktech.com` to `127.0.0.1:3100` with WebSocket support. The rules are the same: separate file, test first, reload not restart, and pass the real visitor address (`TRUST_PROXY`).

---

## Phase 7. Calls (coturn)

**Voice and video calls are on from day one, so this phase is required before launch** (do it before Phase 10, whose call test must pass). Without a relay, many calls on mobile networks, campus and office Wi-Fi fail. Install the relay and **limit it so it cannot eat the server's bandwidth**. On your server nothing else uses 3478 or the relay ports, and the `denied-peer-ip` list below also blocks Docker's internal networks (172.16.0.0/12), so the relay cannot be used to reach ExamSuit's containers or databases.

```bash
sudo apt-get install -y coturn
sudo sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
```

`/etc/turnserver.conf` (replace the whole file; keep a copy of the original):

```ini
listening-port=3478
# On a VPS with a public IP on the network card no external-ip line is needed. If calls connect but have no sound, add:
# external-ip=YOUR.PUBLIC.IP
realm=turn.prayuktech.com
fingerprint
use-auth-secret
static-auth-secret=THE-SAME-SECRET-AS-TURN_SECRET

# only this small range of relay ports is used (open exactly this in the firewall)
min-port=50000
max-port=50499

# limits: protects the server and ExamSuit (coturn counts BYTES per second, not bits)
total-quota=300          # simultaneous relayed calls
user-quota=6             # per person
max-bps=250000           # about 2 Mbit/s for each relayed stream
bps-capacity=37500000    # about 300 Mbit/s for the whole relay (your port is 1 Gbit/s; the rest stays for ExamSuit and the web app)

# never relay into private or internal networks (stops people using your TURN server to reach internal services)
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=224.0.0.0-255.255.255.255

no-cli
syslog
```

```bash
sudo systemctl enable --now coturn
sudo ss -ulnp | grep 3478; sudo ss -tlnp | grep 3478
```

Put the same secret in `/etc/vartiq/vartiq.env` (`TURN_SECRET`, `TURN_URLS`) and `sudo systemctl restart vartiq`. Each person's app then gets credentials that expire after `TURN_TTL_SECONDS`, so strangers cannot use your relay.

### 7.2 TURN over TLS (recommended from day one)

Many school, college and office networks block UDP. TURN over TLS on port 5349 lets calls work there. It needs a certificate for `turn.prayuktech.com`, which you already requested in Phase 6 (Step 1; the port-80 block there also answers the Let's Encrypt check for this name, so ExamSuit's nginx file is never touched). Now let coturn read it and keep it fresh at every renewal:

```bash
# let coturn read the certificate, and keep it fresh at every renewal
sudo mkdir -p /etc/coturn/certs
sudo tee /etc/letsencrypt/renewal-hooks/deploy/coturn.sh >/dev/null <<'EOF'
#!/bin/sh
install -m 640 -o root -g turnserver /etc/letsencrypt/live/turn.prayuktech.com/fullchain.pem /etc/coturn/certs/fullchain.pem
install -m 640 -o root -g turnserver /etc/letsencrypt/live/turn.prayuktech.com/privkey.pem /etc/coturn/certs/privkey.pem
systemctl restart coturn
EOF
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/coturn.sh && sudo /etc/letsencrypt/renewal-hooks/deploy/coturn.sh
```

Add to `/etc/turnserver.conf`: `tls-listening-port=5349`, `cert=/etc/coturn/certs/fullchain.pem`, `pkey=/etc/coturn/certs/privkey.pem`, `no-tlsv1`, `no-tlsv1_1`; then `sudo systemctl restart coturn`. In `/etc/vartiq/vartiq.env` extend `TURN_URLS` with `,turns:turn.prayuktech.com:5349?transport=tcp` and restart VartiQ. (Certbot's renewal timer already exists on this server; it will renew this certificate too and run the hook. Restarting coturn only drops calls that were using the relay at that moment, about every 60 days.)

**Bandwidth (your plan: 1 Gbit/s port, 16 TB per month).** A relayed call passes through the server both ways, so only the *outgoing* half is counted below (if Hostinger counts incoming traffic too, halve the numbers).

| Call type | Outgoing traffic of the relay | Per 100 minutes |
| --- | --- | --- |
| Voice (1:1) | about 0.1 Mbit/s | about 75 MB |
| Video 720p (1:1) | about 4 to 5 Mbit/s | about 3.5 GB |

- **Capacity at one moment:** the 300 Mbit/s cap in the config allows roughly 60 relayed 1:1 video calls or several thousand relayed voice calls at the same time. More calls than that get worse quality instead of slowing ExamSuit. The 1 Gbit/s port is never the limit; the monthly allowance is.
- **Monthly allowance:** 16 TB is about 49 Mbit/s of traffic around the clock. Most calls connect directly and never touch the relay (often 70 to 80 percent). As an example, 2,000 people making 10 minutes of calls a day, a quarter of them relayed and 30 percent of those video, is about 60 GB a day, or 1.8 TB a month, about 11 percent of the allowance. The worst case, if every call were relayed video, would use the whole 16 TB at about 7,000 hours of calls a month.
- **Watch it:** `sudo apt-get install -y vnstat` then `vnstat -m` shows the month so far. Set a reminder at 10 TB. If you approach it, lower `max-bps` (for example to `125000`, about 1 Mbit/s a stream) before anything else.
- Web, chat, voice notes and photos are small by comparison (about a few GB a month per 10,000 active people), so they do not change this picture.

---

## Phase 8. Firewall

Open **only** what is new. Do not remove or reorder existing rules. In whichever firewall you use (ufw, and/or the Hostinger hPanel firewall; if both exist, change both):

| Port | Protocol | From | Why |
| --- | --- | --- | --- |
| 80, 443 | TCP | anywhere (already open for ExamSuit) | the web app |
| 3478 | UDP and TCP | anywhere | TURN |
| 5349 | TCP | anywhere | TURN over TLS (7.2) |
| 50000-50499 | UDP | anywhere | TURN relay range |
| 3100 | TCP | **nobody** | VartiQ listens on 127.0.0.1 only |
| 5432 / 5433 | TCP | **nobody** | PostgreSQL |

```bash
# only if you use ufw, and only these lines:
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 5349/tcp
sudo ufw allow 50000:50499/udp
sudo ufw status numbered
```

Confirm from your own computer that the app and database are **not** reachable: `nc -vz YOUR.IP 3100` and `nc -vz YOUR.IP 5433` must fail or time out.

---

## Phase 9. Backups

What must be backed up: the **database** and the **media folder**. Hostinger snapshots are a second layer, not a replacement.

`/usr/local/bin/vartiq-backup`:

```bash
#!/usr/bin/env bash
set -euo pipefail
DEST=/var/backups/vartiq
STAMP=$(date +%F-%H%M)
mkdir -p "$DEST/db" "$DEST/media"
# database (port 5433 = Option B; use 5432 for Option A or C)
sudo -u postgres pg_dump -p 5433 -Fc vartiq > "$DEST/db/vartiq-$STAMP.dump"
# push notification keys (only if you did not put them in vartiq.env) and the settings file: secrets, owner-only
[ -f /var/lib/vartiq/vapid.json ] && install -m 600 /var/lib/vartiq/vapid.json "$DEST/vapid-$STAMP.json"
install -m 600 /etc/vartiq/vartiq.env "$DEST/vartiq.env-$STAMP"
# media: a hard-linked snapshot per day, only changed files take space
rsync -a --delete --link-dest="$DEST/media/latest" /var/lib/vartiq/media/ "$DEST/media/$STAMP/"
ln -sfn "$DEST/media/$STAMP" "$DEST/media/latest"
# keep 14 days locally (match the "days in backups" you published in Admin -> Settings -> Legal; never more)
find "$DEST/db" -name '*.dump' -mtime +14 -delete
find "$DEST" -maxdepth 1 \( -name 'vapid-*.json' -o -name 'vartiq.env-*' \) -mtime +14 -delete
find "$DEST/media" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
# copy off the server (rclone to object storage, or rsync to another machine)
# rclone sync "$DEST" remote:vartiq-backups --transfers 4
```

```bash
sudo chmod +x /usr/local/bin/vartiq-backup
echo '17 2 * * * root /usr/local/bin/vartiq-backup >> /var/log/vartiq-backup.log 2>&1' | sudo tee /etc/cron.d/vartiq-backup
sudo /usr/local/bin/vartiq-backup && ls -lh /var/backups/vartiq/db
```

**Test a restore once, before launch**, into a throw-away database, so you know it works:

```bash
sudo -u postgres createdb vartiq_restore_test
sudo -u postgres pg_restore -d vartiq_restore_test /var/backups/vartiq/db/vartiq-LATEST.dump
sudo -u postgres psql -d vartiq_restore_test -c "SELECT coll, count(*) FROM docs GROUP BY coll;"
sudo -u postgres dropdb vartiq_restore_test
```

Backups contain personal data and encrypted chats: keep them off public storage, encrypt them off the server, and delete them on the schedule you promise in the Privacy Notice.

**How much space:** about 0.5 KB per plain message and about 1 KB per end-to-end-encrypted message in the database (more in large groups), plus media files. 1 million messages is roughly 1 GB. Keep an eye on `df -h` and on `/var/lib/vartiq/media`.

---

## Phase 10. Check everything before anyone is invited

Use a staff phone on mobile data, and a laptop on Wi-Fi.

1. `https://vartiq.prayuktech.com` loads with a valid lock icon; `http://` redirects to `https://`.
2. `https://vartiq.prayuktech.com/legal/privacy` and `/legal/terms` show **your company details, no `[square brackets]`**.
3. `https://vartiq.prayuktech.com/admin` returns 404 from the internet, and `http://localhost:3100/admin` works for you through the tunnel. Sign in; the Overview shows no "Legal details are missing" warning.
4. Sign up with a real mobile number: the SMS arrives, you must tick the consent box, the account is created.
5. Open two accounts on two devices, send text and a voice note, see delivery ticks. Reload: the chat history is still there (PostgreSQL works).
6. **Restart test:** `sudo systemctl restart vartiq`; the app reconnects by itself and **nobody is logged out** (sessions are saved in the database).
7. **Call test across networks:** phone on 4G calls laptop on Wi-Fi. If it connects, check that the relay works at all: `sudo journalctl -u coturn -n 20` (a "session ... allocation" line) or use the Trickle ICE test page with your `turn:` URL and a generated credential. If calls fail only across networks, the relay or its firewall ports are the cause.
8. Download my data and Delete my account work for a test user (the data is erased about an hour later).
8b. **Payment test (Razorpay test mode):** with `rzp_test_` keys and the webhook added in the Razorpay Dashboard (URL `https://vartiq.prayuktech.com/webhooks/razorpay`, events `payment_link.paid` and `refund.processed`, the same secret as `RAZORPAY_WEBHOOK_SECRET`), buy a plan in the app and pay with Razorpay's test UPI id or test card. The app must say "Payment received" by itself and Premium turn on; the Admin → Payments page lists it; a second delivery from the Dashboard (Webhooks → resend) must change nothing. Then switch to the `rzp_live_` keys and the live webhook, and repeat with the smallest plan (a refund of it from the Razorpay Dashboard takes the period back). The webhook only accepts signed POSTs (a browser visit gets a 404 page), and it is a normal HTTPS path on the same site, so nginx and the firewall need nothing special; the Dashboard shows each delivery's response (it must be 200).
8a. **Under-18 test:** sign up a test account with a date of birth that makes it 14 and a parent number you control: the parent gets an SMS or email with a link that starts with `https://vartiq.prayuktech.com/guardian/`; until it is opened the account shows "Waiting for your parent or guardian"; after agreeing, the app opens by itself. In the parent page switch *Sharing location* on and off and *Disable the account* then *Enable* again. A 7-year-old date of birth must be refused. If no message arrives, check `OTP_WEBHOOK_URL` and the gateway: it must send the `text` of every message, including ones with `purpose: "guardian"` that have no code.
9. **Notifications test** (a phone, over HTTPS): Profile → Notifications → Turn on, allow, tap *Send a test* (it arrives). Close the app, send that phone a message from another account: a notification "Name: New message" arrives, and tapping it opens the chat. On iPhone/iPad the app must be added to the Home Screen first. Turn it off again and check nothing arrives.
10. **Location test:** share a location once and a live one (15 minutes) between two phones: the other phone sees the position move when the first walks (with VartiQ open); tapping *Stop sharing* ends it ("Live location ended"). Open the Privacy Notice and check the new sections on notifications and location are there.
11. **ExamSuit check:** the HTTP code and time are the same as your "before" numbers; `free -h` shows what you expected.
12. Watch for 30 minutes: `systemd-cgtop`, `sudo journalctl -u vartiq -f`.

---

## Phase 11. Go live gently

1. Keep **registration closed** until you are ready: Admin → Features → "New sign-ups" off. Invite staff by switching it on only for the test, then off.
2. Fill in **Admin → Settings → Legal** and have your lawyer review the Terms and Privacy Notice (they are not legal advice).
3. Admin → Settings: check the free limits and prices.
4. Turn "New sign-ups" **on** at the time you announce. Watch ExamSuit's response time and the server for the first hours.
5. Leave the **Developer API off** until the ExamSuit connection is designed (it is off by default).

---

## Everyday operations

| Task | Command |
| --- | --- |
| Is it healthy? | `curl -s https://vartiq.prayuktech.com/api/v1/config \| head -c 100`; set an external uptime monitor on that address |
| Logs | `sudo journalctl -u vartiq -f` (and `-u coturn`, `-u nginx`) |
| Restart | `sudo systemctl restart vartiq` (a few seconds; people reconnect and stay logged in) |
| Update | `sudo vartiq-deploy` (rolls back by itself if the new version does not start) |
| Memory and CPU of each service | `systemd-cgtop` |
| Connected people | Admin → Overview ("Online now") |
| Database size | `sudo -u postgres psql -d vartiq -c "SELECT pg_size_pretty(pg_database_size('vartiq'));"` |
| Disk | `df -h /` and `du -sh /var/lib/vartiq/media` |

Things to watch (set alerts if your provider offers them): disk above 80%, available memory below 3 GB, `vartiq` restarting repeatedly (`systemctl status vartiq`), and ExamSuit's own response time.

Keep in mind: a restart briefly disconnects everyone (they come back in seconds). Voice and video calls in progress end. Do deployments at quiet hours. If you outgrow one process (more than roughly 10,000 to 20,000 people online at once), the next step is several processes with Redis; see the README.

**Do not run the load-test tool (`tools/load-test`) on this server while ExamSuit is serving people.** It is meant for a separate machine.

---

## Emergency: switch VartiQ off without touching ExamSuit

```bash
sudo systemctl stop vartiq coturn            # VartiQ and calls stop; ExamSuit is untouched
sudo rm /etc/nginx/sites-enabled/vartiq
sudo nginx -t && sudo systemctl reload nginx # the chat hostname no longer reaches this server's app
```

To remove VartiQ completely later: disable the services, remove `/opt/vartiq`, `/etc/vartiq`, the `vartiq` database and role, and the nginx file. Keep `/var/lib/vartiq` and the backups until you have decided what the law requires you to keep.

---

## Known limits of this setup

- **One server, one process.** A hardware or Hostinger outage takes both ExamSuit and VartiQ down. Daily backups and snapshots limit the damage; a second machine is the real fix.
- **Calls use the server's bandwidth** when they need the relay. Large group video calls are not supported well (everyone sends video to everyone).
- **A shared server means shared risk.** If a busy VartiQ day or exam day pushes memory or CPU too high, the limits in the service file keep VartiQ from taking more than its share, and `Nice` gives ExamSuit priority, but the machine is still shared. If you see ExamSuit slow down, lower `CPUQuota` or move VartiQ to its own server.
- **No Cloudflare means no shield in front of the server.** A flood of traffic hits the server (and so ExamSuit) directly. The nginx limits, the admin allow list and Hostinger's network filtering help, but if you see abuse, adding Cloudflare to `vartiq.prayuktech.com` is a DNS-only change (6.4). Without it, HTTPS ends on your own server and no third party sees the traffic.
