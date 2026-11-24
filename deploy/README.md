# Deploy PraYukTech to the VPS

1. DNS: point A records for `prayuktech.com` and `www` to the VPS IP.
2. Upload from your PC (PowerShell), replacing USER and VPS_IP:
   `scp -r "C:\PraYuktech Web" USER@VPS_IP:/tmp/prayuktech-web`
3. SSH in and run:
   `ssh USER@VPS_IP`
   `cd /tmp/prayuktech-web && sudo bash deploy/deploy.sh`
4. Open https://prayuktech.com and check the privacy page: https://prayuktech.com/privacy-policy.html

Notes
- The script adds only a new Nginx site and checks the config (`nginx -t`) before reloading, so ExamSuit and VartiQ stay untouched.
- If ExamSuit runs in Docker or behind another proxy that owns ports 80/443, do not run this script; send the proxy details and I'll adapt it.
- Replace the TODO placeholders (Play Store links, email) before or after going live; re-run the script to update.
