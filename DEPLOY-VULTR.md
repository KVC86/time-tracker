# Deploy on a single Ubuntu server (Vultr) with Nginx + HTTPS

A complete, copy-pasteable runbook for running this project on one small VPS
(e.g. Vultr **vhf-1c-2gb** — 1 vCPU / 2 GB RAM / 64 GB NVMe) behind Nginx.

**These instructions assume you are logged in as a normal user with `sudo`** (not
root), on **Ubuntu 22.04 / 24.04 LTS**. System commands are prefixed with `sudo`;
Docker commands run without `sudo` once your user is in the `docker` group.

> **Scope.** One box like this is great for a demo or light pilot, but it is *not*
> the ~3,000-concurrent-user design point — that needs the multi-tier topology in
> [`README-architecture.md`](README-architecture.md) §2.

---

## 0. (If you haven't already) create the sudo user

Run this **once, as root**, then reconnect as the new user for everything below:

```bash
adduser deploy                    # creates the user + sets a password
usermod -aG sudo deploy           # grant sudo
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy/   # copy your SSH key
# then: ssh deploy@YOUR_SERVER_IP
```

Everything from here runs as that sudo user.

---

## 1. Update the system

```bash
sudo apt update && sudo apt -y upgrade
sudo apt install -y git ca-certificates curl
```

## 2. Add 2 GB swap (safety net for 2 GB RAM)

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab   # persist across reboots
free -h                                                      # confirm 2.0Gi swap
```

## 3. Install Docker, and run it without `sudo`

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER       # let your user run docker without sudo
```

**Log out and back in** (or run `newgrp docker`) so the group membership takes
effect, then verify — this should work **without** `sudo`:

```bash
docker run --rm hello-world
docker compose version
```

## 4. Firewall — open web ports, not 3000

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80
sudo ufw allow 443
sudo ufw --force enable
```

> Don't try to "block 3000" with ufw — Docker publishes ports through its own
> iptables rules and **bypasses ufw**. We keep 3000 private a reliable way in step 6.

## 5. Get the project

```bash
cd ~
git clone https://github.com/KVC86/time-tracker.git
cd time-tracker
```

## 6. Bind the app to localhost (only Nginx should reach it)

```bash
sed -i 's/"3000:3000"/"127.0.0.1:3000:3000"/' docker-compose.prod.yml
grep -n 3000 docker-compose.prod.yml      # should show 127.0.0.1:3000:3000
```

## 7. Create the `.env` (the one required secret + DB password)

```bash
cat > .env <<EOF
JWT_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 16)
WEB_ORIGIN=https://your-domain.com
EOF
cat .env       # save these somewhere safe
```

| Variable | Required? | Purpose |
|---|---|---|
| `JWT_SECRET` | **Yes** | Signs JWT access/refresh tokens. Long random value. |
| `POSTGRES_PASSWORD` | No (default `wfm`) | Password for the bundled Postgres. |
| `WEB_ORIGIN` | No (default `*`) | Allowed CORS origin — set to your real domain. |

## 8. Get the container image from GHCR

GHCR packages are **private by default**, so pick one:

- **Easiest — make the package public** (one time): GitHub → repo → **Packages** →
  the `time-tracker` package → **Package settings** → **Change visibility → Public**.
  Then no login is needed on the server.
- **Or log in** with a GitHub token that has `read:packages`:
  ```bash
  echo 'YOUR_GITHUB_PAT' | docker login ghcr.io -u KVC86 --password-stdin
  ```

## 9. Pull and start the stack

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

On first boot the app auto-runs `prisma migrate deploy` and applies the partial
indexes — no manual database step. Verify:

```bash
docker compose -f docker-compose.prod.yml ps                # all running/healthy
docker compose -f docker-compose.prod.yml logs -f app       # "Time Tracker API running on ..."
curl -s http://127.0.0.1:3000/ | head                       # serves the client
```

## 10. Seed the default WFM account (one-time)

```bash
docker compose -f docker-compose.prod.yml exec app npx prisma db seed
# prints: alex.cruz@acme.test  /  WFM-01   password Password123!
```

> **Change `Password123!`** before anyone real uses this.

---

## 11. Install and configure Nginx

```bash
sudo apt install -y nginx
sudo tee /etc/nginx/sites-available/time-tracker > /dev/null <<'EOF'
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # required for Socket.IO real-time (WebSocket upgrade)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

sudo sed -i 's/your-domain.com/YOUR_ACTUAL_DOMAIN/' /etc/nginx/sites-available/time-tracker
sudo ln -s /etc/nginx/sites-available/time-tracker /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

> Point your domain's **DNS A record** at `YOUR_SERVER_IP` first, then test:
> `curl http://YOUR_ACTUAL_DOMAIN/`.

## 12. Add HTTPS (free, auto-renewing)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d YOUR_ACTUAL_DOMAIN --redirect -m you@email.com --agree-tos
```

Certbot rewrites the Nginx config for HTTPS and renews automatically. Site is live
at `https://YOUR_ACTUAL_DOMAIN`. Make sure `.env`'s `WEB_ORIGIN` matches; if you
change `.env`, restart the app:

```bash
docker compose -f docker-compose.prod.yml up -d
```

---

## 13. Harden SSH (recommended)

Once you've confirmed the sudo user can log in and run `sudo`:

```bash
sudo nano /etc/ssh/sshd_config
#   PermitRootLogin no
#   PasswordAuthentication no        # only if you use SSH keys
sudo systemctl restart ssh
```

> Test in a **second terminal** before closing your session, so a bad config
> doesn't lock you out.

---

## Updating to a new release later

```bash
cd ~/time-tracker
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d     # migrations apply automatically
```

## No domain yet?

Let's Encrypt won't issue certs for a bare IP. You can run **HTTP-only**: in step 11
use `server_name _;`, skip step 12, and reach it at `http://YOUR_SERVER_IP`. Fine
for a quick demo, but not secure for real logins — get a cheap domain before going live.
