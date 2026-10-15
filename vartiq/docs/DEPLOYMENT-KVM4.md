# Deploying VartiQ on the KVM 4 server that already runs ExamSuit

**Read this first.** ExamSuit is live on this server. Everything below is built so that VartiQ is added *next to* ExamSuit without touching it: its own system user, its own folders, its own database, its own web-server file, its own ports, hard CPU and memory limits, and a one-command way to switch VartiQ off again. Nothing here edits an ExamSuit file, restarts ExamSuit, or reloads anything but a *tested* nginx configuration.

Assumptions (check them in Phase 0): Hostinger KVM 4 (about 4 vCPU, 16 GB RAM, 200 GB NVMe, public IPv4), Ubuntu or Debian, Cloudflare in front of your domain, ExamSuit served by nginx. Where ExamSuit uses something else (Apache, Docker, a different database) the guide says what to change.

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
 People ──► Cloudflare (HTTPS, DDoS protection, WebSockets)
                │
                ▼  chat.example.com (proxied)
          nginx on the server  ── ExamSuit's own site files stay as they are
                │  127.0.0.1:3000
                ▼
          VartiQ (Node.js, systemd service, limited to ~4 GB RAM / 1.5 CPU)
                │
                ├──► PostgreSQL (database "vartiq", only reachable from this machine)
                └──► /var/lib/vartiq/media (voice notes, status photos, product pictures)

 Calls, when phones cannot connect directly:
 People ──► turn.example.com (NOT proxied by Cloudflare) ──► coturn on UDP/TCP 3478
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

## Phase 2. Domain and Cloudflare

You need two names under your domain (replace `example.com`):

| Name | Purpose | Cloudflare proxy |
| --- | --- | --- |
| `chat.example.com` | the VartiQ web app, API and admin | **Proxied (orange cloud)** |
| `turn.example.com` | the call relay | **DNS only (grey cloud)**: Cloudflare's proxy cannot carry call traffic |

Both point to the server's public IP (`A` record; add `AAAA` only if the server has IPv6 and you open it in the firewall).

Cloudflare settings for `chat.example.com`:

1. **SSL/TLS → Overview:** mode **Full (strict)**.
2. **SSL/TLS → Origin Server → Create Certificate** for `chat.example.com` (15 years). Save the two files on the server (Phase 5):
   `/etc/ssl/vartiq/origin.pem` and `/etc/ssl/vartiq/origin.key` (mode `600`).
3. **Network:** WebSockets **On** (it is by default).
4. **Caching → Configuration:** make sure `chat.example.com/api/*`, `/socket.io/*` and `/admin/*` are **not cached** (add a Cache Rule "Bypass cache" for those paths).
5. **Speed → Optimization:** turn **off** Rocket Loader and Auto Minify for this hostname (they can break the app's scripts).
6. **SSL/TLS → Edge Certificates:** Always Use HTTPS **On**; Minimum TLS **1.2**.
7. **Security → WAF:** keep the managed rules on. Add a rule that **challenges or blocks** `chat.example.com/admin*` for everyone except your office IPs (or put `/admin` behind Cloudflare Access). The admin dashboard should never be open to the whole internet.
8. If you use "Bot Fight Mode" or "Super Bot Fight", test the app with your phone before launch; if sign-in OTP calls get blocked, add a skip rule for `/api/v1/*`.

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

### Option B: a separate PostgreSQL cluster on its own port (safest for ExamSuit)

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
if curl -fsS http://127.0.0.1:3000/api/v1/config >/dev/null; then
  echo "OK: running $REL"
  ls -dt /opt/vartiq/releases/* | tail -n +6 | xargs -r sudo rm -rf   # keep the last 5
else
  echo "FAILED: rolling back to $PREV"
  [ -n "$PREV" ] && sudo -u vartiq ln -sfn "$PREV" /opt/vartiq/current && sudo systemctl restart vartiq
  exit 1
fi
```

(If you chose `PORT=3100`, change it in the `curl` line.) You can run the app's tests on your own computer or CI before you deploy: `npm test`. There is no need to install dev packages on the server.

### 5.3 Configuration file

Create `/etc/vartiq/vartiq.env` (owner root, group vartiq, mode `640`). **Every secret is yours to generate**; `openssl rand -base64 32` is fine.

```bash
# ---- where it listens (only nginx on this machine may reach it)
HOST=127.0.0.1
PORT=3000
TRUST_PROXY=loopback            # the real visitor address comes from nginx; without this every visitor shares one rate limit

# ---- data
DATABASE_URL=postgres://vartiq:PASSWORD@127.0.0.1:5432/vartiq     # 5433 for Option B
MEDIA_DIR=/var/lib/vartiq/media
CORS_ORIGINS=https://chat.example.com

# ---- administrator (created or updated at every start; use 16+ random characters)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=CHANGE-ME-LONG-RANDOM

# ---- who is responsible (printed in the Terms and Privacy Notice; also editable in Admin -> Settings -> Legal)
LEGAL_COMPANY=Your Company Legal Name
LEGAL_ADDRESS=Registered address
LEGAL_CONTACT_EMAIL=hello@example.com
LEGAL_GRIEVANCE_NAME=Grievance Officer name
LEGAL_GRIEVANCE_EMAIL=grievance@example.com
LEGAL_CITY=City for courts
LEGAL_HOSTING=India (your data centre location)

# ---- calls (Phase 7): short-lived credentials for your own TURN server
TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
TURN_SECRET=THE-SAME-SECRET-AS-IN-coturn
TURN_TTL_SECONDS=86400

# ---- real providers (each is a small relay you control; see README). Leave a line out to leave that feature OFF
OTP_WEBHOOK_URL=https://...
OTP_WEBHOOK_TOKEN=...
KYC_WEBHOOK_URL=https://...
KYC_WEBHOOK_TOKEN=...
PAYMENT_WEBHOOK_URL=https://...
PAYMENT_WEBHOOK_TOKEN=...
PLAN_CURRENCY=INR
TRANSLATE_WEBHOOK_URL=https://...
TRANSLATE_WEBHOOK_TOKEN=...

# ---- account deletion: how long after the request the data is erased (never more than 24 hours)
ACCOUNT_ERASE_DELAY_MS=3600000
```

**Must NOT appear in this file in production:** `OTP_DEV_CODES`, `KYC_SANDBOX`, `PAYMENTS_SANDBOX`, `TRANSLATE_SANDBOX`, `WEBHOOKS_ALLOW_PRIVATE`. The sandbox switches give away verification and Premium, and `OTP_DEV_CODES` shows login codes on screen. Check: `grep -E "SANDBOX|DEV_CODES" /etc/vartiq/vartiq.env` must print nothing.

Without `OTP_WEBHOOK_URL` login codes are only printed in the server log and nobody receives an SMS, so real sign-up does not work until it is set.

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
# expect: "VartiQ running at http://127.0.0.1:3000" and "Data: PostgreSQL"
curl -s http://127.0.0.1:3000/api/v1/config | head -c 200
```

(The first `vartiq-deploy` run restarts the service before it exists as enabled; that is fine. If it reports failure, read the journal.)

Run the **ExamSuit check**.

---

## Phase 6. nginx: one new file, tested before it is loaded

Use a **separate file**. Never edit ExamSuit's. Names starting with `vq_` avoid clashing with anything ExamSuit already defines (a duplicate `map` or `limit_req_zone` name would make `nginx -t` fail, which is exactly why you test first).

### 6.1 Cloudflare addresses (so nginx logs and passes on the real visitor address)

`/etc/nginx/snippets/vartiq-cloudflare-realip.conf` (a small script keeps it current):

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

### 6.2 The site

`/etc/nginx/conf.d/vartiq.conf`:

```nginx
# WebSocket upgrade (names are unique to VartiQ)
map $http_upgrade $vq_connection_upgrade { default upgrade; '' close; }

# Gentle limit on sign-in style calls; ExamSuit is not affected (own zone)
limit_req_zone $binary_remote_addr zone=vq_auth:10m rate=10r/s;

server {
    listen 80;
    server_name chat.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name chat.example.com;
    # nginx 1.25.1 or newer: add the line  http2 on;  (older versions: write  listen 443 ssl http2;  above instead)

    ssl_certificate     /etc/ssl/vartiq/origin.pem;
    ssl_certificate_key /etc/ssl/vartiq/origin.key;
    ssl_protocols TLSv1.2 TLSv1.3;

    include /etc/nginx/snippets/vartiq-cloudflare-realip.conf;

    client_max_body_size 5m;                 # voice notes and photos are small
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header Strict-Transport-Security "max-age=31536000" always;

    location /api/v1/auth/ {
        limit_req zone=vq_auth burst=30 nodelay;
        proxy_pass http://127.0.0.1:3000;
        include /etc/nginx/snippets/vartiq-proxy.conf;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
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

Put the Cloudflare **origin certificate** from Phase 2 in place first:

```bash
sudo mkdir -p /etc/ssl/vartiq && sudo nano /etc/ssl/vartiq/origin.pem   # paste certificate
sudo nano /etc/ssl/vartiq/origin.key                                    # paste private key
sudo chmod 600 /etc/ssl/vartiq/origin.key
```

### 6.3 Test, then load. Never restart.

```bash
sudo nginx -t          # must say "syntax is ok" and "test is successful"
sudo systemctl reload nginx
```

If `nginx -t` fails, **do not reload**. Read the message (usually a duplicate name or a missing certificate), fix `vartiq.conf`, and test again. `reload` swaps the configuration without dropping ExamSuit's connections. If you cannot fix it quickly: `sudo rm /etc/nginx/conf.d/vartiq.conf` and ExamSuit is exactly as before.

Run the **ExamSuit check**, then open `https://chat.example.com`. You should see the VartiQ sign-in page.

*If ExamSuit is not behind nginx:* Apache needs `mod_proxy`, `mod_proxy_wstunnel` and `ProxyPass "/socket.io/" "ws://127.0.0.1:3000/socket.io/"` plus `ProxyPass "/" "http://127.0.0.1:3000/"` and `ProxyPreserveHost On` in a new `VirtualHost` file; Docker/Traefik/Caddy users add a router for `chat.example.com` to `127.0.0.1:3000` with WebSocket support. The rules are the same: separate file, test first, reload not restart, and pass the real visitor address (`TRUST_PROXY`).

---

## Phase 7. Calls (coturn)

Without a relay, many calls on mobile networks fail. Install the relay and **limit it so it cannot eat the server's bandwidth**.

```bash
sudo apt-get install -y coturn
sudo sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
```

`/etc/turnserver.conf` (replace the whole file; keep a copy of the original):

```ini
listening-port=3478
# On a VPS with a public IP on the network card no external-ip line is needed. If calls connect but have no sound, add:
# external-ip=YOUR.PUBLIC.IP
realm=turn.example.com
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
bps-capacity=12500000    # about 100 Mbit/s for the whole relay; lower it if your plan's network is slower

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

Put the same secret in `/etc/vartiq/vartiq.env` (`TURN_SECRET`, `TURN_URLS`) and `sudo systemctl restart vartiq`. Each person's app then gets credentials that expire after `TURN_TTL_SECONDS`, so strangers cannot use your relay. (TURN over TLS on port 5349 helps people on networks that block UDP; add it later with a certificate for `turn.example.com`, for example from `certbot certonly --dns-cloudflare`.)

**Bandwidth reality check:** one relayed 720p video call is about 3 Mbit/s in total. 100 such calls is about 300 Mbit/s. Ask Hostinger what network speed and monthly transfer your plan includes and keep `total-quota` below what it can carry. Most calls connect directly and never touch the relay.

---

## Phase 8. Firewall

Open **only** what is new. Do not remove or reorder existing rules. In whichever firewall you use (ufw, and/or the Hostinger hPanel firewall; if both exist, change both):

| Port | Protocol | From | Why |
| --- | --- | --- | --- |
| 80, 443 | TCP | anywhere (already open for ExamSuit) | the web app |
| 3478 | UDP and TCP | anywhere | TURN |
| 50000-50499 | UDP | anywhere | TURN relay range |
| 3000 | TCP | **nobody** | VartiQ listens on 127.0.0.1 only |
| 5432 / 5433 | TCP | **nobody** | PostgreSQL |

```bash
# only if you use ufw, and only these lines:
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 50000:50499/udp
sudo ufw status numbered
```

Confirm from your own computer that the app and database are **not** reachable: `nc -vz YOUR.IP 3000` and `nc -vz YOUR.IP 5432` must fail or time out.

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
# database (change -p 5433 for Option B)
sudo -u postgres pg_dump -p 5432 -Fc vartiq > "$DEST/db/vartiq-$STAMP.dump"
# media: a hard-linked snapshot per day, only changed files take space
rsync -a --delete --link-dest="$DEST/media/latest" /var/lib/vartiq/media/ "$DEST/media/$STAMP/"
ln -sfn "$DEST/media/$STAMP" "$DEST/media/latest"
# keep 14 days locally (match the "days in backups" you published in Admin -> Settings -> Legal; never more)
find "$DEST/db" -name '*.dump' -mtime +14 -delete
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

1. `https://chat.example.com` loads with a valid lock icon; `http://` redirects to `https://`.
2. `https://chat.example.com/legal/privacy` and `/legal/terms` show **your company details, no `[square brackets]`**.
3. `https://chat.example.com/admin` is blocked for the public (Cloudflare rule) and works for you. Sign in; the Overview shows no "Legal details are missing" warning.
4. Sign up with a real mobile number: the SMS arrives, you must tick the consent box, the account is created.
5. Open two accounts on two devices, send text and a voice note, see delivery ticks. Reload: the chat history is still there (PostgreSQL works).
6. **Restart test:** `sudo systemctl restart vartiq`; the app reconnects by itself and **nobody is logged out** (sessions are saved in the database).
7. **Call test across networks:** phone on 4G calls laptop on Wi-Fi. If it connects, check that the relay works at all: `sudo journalctl -u coturn -n 20` (a "session ... allocation" line) or use the Trickle ICE test page with your `turn:` URL and a generated credential. If calls fail only across networks, the relay or its firewall ports are the cause.
8. Download my data and Delete my account work for a test user (the data is erased about an hour later).
9. **ExamSuit check:** the HTTP code and time are the same as your "before" numbers; `free -h` shows what you expected.
10. Watch for 30 minutes: `systemd-cgtop`, `sudo journalctl -u vartiq -f`.

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
| Is it healthy? | `curl -s https://chat.example.com/api/v1/config \| head -c 100`; set an external uptime monitor on that address |
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
sudo mv /etc/nginx/conf.d/vartiq.conf /root/vartiq.conf.disabled
sudo nginx -t && sudo systemctl reload nginx # the chat hostname no longer reaches this server's app
```

To remove VartiQ completely later: disable the services, remove `/opt/vartiq`, `/etc/vartiq`, the `vartiq` database and role, and the nginx file. Keep `/var/lib/vartiq` and the backups until you have decided what the law requires you to keep.

---

## Known limits of this setup

- **One server, one process.** A hardware or Hostinger outage takes both ExamSuit and VartiQ down. Daily backups and snapshots limit the damage; a second machine is the real fix.
- **Calls use the server's bandwidth** when they need the relay. Large group video calls are not supported well (everyone sends video to everyone).
- **A shared server means shared risk.** If a busy VartiQ day or exam day pushes memory or CPU too high, the limits in the service file keep VartiQ from taking more than its share, and `Nice` gives ExamSuit priority, but the machine is still shared. If you see ExamSuit slow down, lower `CPUQuota` or move VartiQ to its own server.
- **Cloudflare is a middleman for chat traffic** (HTTPS is ended at Cloudflare). Messages typed in the web app are still end-to-end encrypted, but Cloudflare can see who connects and the unencrypted parts (API messages, public channels, status updates). The Privacy Notice already says which parts are not end-to-end encrypted; tell your lawyer that Cloudflare is one of your providers.
