#!/usr/bin/env bash
# Checks VartiQ and the server and tells you on Telegram when something changes. Run by cron every 5 minutes.
set -u
# shellcheck disable=SC1091
source /etc/vartiq/watch.env            # TG_TOKEN, TG_CHAT, HEARTBEAT_URL (optional)
STATE=/var/lib/vartiq-watch
mkdir -p "$STATE"
problems=()

curl -fsS -m 10 https://vartiq.prayuktech.com/api/v1/config 2>/dev/null | grep -q '"features"' || problems+=("VartiQ web is not answering")
curl -fsS -m 10 -o /dev/null https://examsuit.com 2>/dev/null || problems+=("ExamSuit is not answering")
for s in vartiq coturn nginx postgresql@16-vartiq; do
  systemctl is-active --quiet "$s" || problems+=("service $s is not running")
done
used=$(df --output=pcent / | tail -1 | tr -dc 0-9)
[ "${used:-0}" -ge 85 ] && problems+=("disk is ${used}% full")
avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
[ "${avail:-0}" -lt 1024 ] && problems+=("only ${avail} MB of RAM is free")
end=$(echo | openssl s_client -connect vartiq.prayuktech.com:443 -servername vartiq.prayuktech.com 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
if [ -z "$end" ]; then
  problems+=("could not read the HTTPS certificate")
else
  days=$(( ( $(date -d "$end" +%s) - $(date +%s) ) / 86400 ))
  [ "$days" -lt 14 ] && problems+=("HTTPS certificate expires in ${days} days")
fi

now=$(IFS='; '; echo "${problems[*]:-}")
last=$(cat "$STATE/last" 2>/dev/null || true)
if [ "$now" != "$last" ]; then
  if [ -z "$now" ]; then msg="OK again: VartiQ server checks pass"; else msg="PROBLEM on VartiQ server: $now"; fi
  curl -fsS -m 10 "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" --data-urlencode "chat_id=${TG_CHAT}" --data-urlencode "text=${msg}" >/dev/null 2>&1 || true
  printf '%s' "$now" > "$STATE/last"
fi
# "I am alive": healthchecks.io emails you if these pings stop (server down)
[ -n "${HEARTBEAT_URL:-}" ] && curl -fsS -m 10 "$HEARTBEAT_URL" >/dev/null 2>&1
exit 0
