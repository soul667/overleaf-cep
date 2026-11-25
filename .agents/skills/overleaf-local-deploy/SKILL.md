---
name: overleaf-local-deploy
description: Automated Docker deployment and operations skill for Overleaf CE+ with FlashTeX hot preview (ghcr.io/soul667/overleaf-cep-flash). Activate when asked to deploy, configure, or troubleshoot this Overleaf CE+ Docker stack, HTTPS/FRP reverse proxy, user activation, or FlashTeX preview service.
---

# Overleaf CE+ (FlashTeX + LocalAi) Docker Deployment Skill

This skill guides an AI agent to deploy and configure `ghcr.io/soul667/overleaf-cep-flash` on any Linux host with Docker Compose.

## 1. Prerequisites Check

Before deploying, verify on the target host:
1. `docker --version` and `docker compose version` are available.
2. Target ports are free (default loopback `127.0.0.1:3082` for Overleaf web).
3. Sufficient disk space (`df -h`), especially if mounting a host TeX Live directory.

## 2. Standard Docker Compose Deployment

Create a deployment directory (e.g., `~/overleaf-ceplus`) with `variables.env` and `compose.yml`.

### 2.1 Generate `variables.env` (600 permissions)

Generate a random `OVERLEAF_SESSION_SECRET` (`openssl rand -hex 32`) and save `variables.env`:

```env
OVERLEAF_APP_NAME=Overleaf CE+
OVERLEAF_SITE_URL=http://127.0.0.1:3082
OVERLEAF_NAV_TITLE=Overleaf CE+
OVERLEAF_SESSION_SECRET=<RANDOM_64_HEX>
OVERLEAF_BEHIND_PROXY=true
OVERLEAF_SECURE_COOKIE=false
ENABLED_LINKED_FILE_TYPES=project_file,project_output_file
ENABLE_CONVERSIONS=true
EMAIL_CONFIRMATION_DISABLED=true
```

> If deploying behind HTTPS reverse proxy, set `OVERLEAF_SITE_URL=https://<YOUR_DOMAIN>` and `OVERLEAF_SECURE_COOKIE=true`.

### 2.2 Create `compose.yml`

```yaml
name: overleaf-ceplus
services:
  app:
    image: ghcr.io/soul667/overleaf-cep-flash:latest
    container_name: overleaf-ceplus
    restart: unless-stopped
    ports:
      - "127.0.0.1:3082:80"
    volumes:
      - ./data/overleaf:/var/lib/overleaf
      # Optional: mount host TeX Live read-only if available
      # - /path/to/texlive:/usr/local/texlive:ro
      # Optional: mount FlashTeX preview IPC socket directory
      # - ~/.local/share/overleaf-flash-preview/ipc:/run/flash-preview:ro
    extra_hosts:
      - "host.docker.internal:host-gateway"
    env_file:
      - variables.env
    environment:
      OVERLEAF_MONGO_URL: mongodb://mongo/sharelatex?replicaSet=overleaf
      OVERLEAF_REDIS_HOST: redis
      REDIS_HOST: redis
    depends_on:
      mongo:
        condition: service_healthy
      redis:
        condition: service_started
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  mongo:
    image: mongo:8.0
    container_name: overleaf-ceplus-mongo
    restart: unless-stopped
    command: ["--replSet", "overleaf", "--bind_ip_all", "--wiredTigerCacheSizeGB", "0.5"]
    volumes:
      - ./data/mongo:/data/db
    healthcheck:
      test: ["CMD-SHELL", "mongosh --quiet --eval 'try { rs.status().ok } catch(e) { rs.initiate({_id:\"overleaf\",members:[{_id:0,host:\"mongo:27017\"}]}) }'"]
      interval: 5s
      timeout: 5s
      retries: 20
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  redis:
    image: redis:7.4
    container_name: overleaf-ceplus-redis
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - ./data/redis:/data
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

Start the stack:

```bash
docker compose -f compose.yml pull
docker compose -f compose.yml up -d
```

Wait for `http://127.0.0.1:3082/login` to return HTTP `200` (or `302`).

## 3. Admin Account & User Activation (CE+ 6.3.0-ext-v5.1)

1. For first-time setup, visit `http://127.0.0.1:3082/launchpad` to create the initial admin account (disable `/launchpad` in Nginx before exposing to public internet).
2. When an admin creates new users in `/admin/user`, CE+ generates a random initial password and a 7-day activation token (there is no password input field in the modal).
3. Click the info icon (`ⓘ`) next to the user, copy the `Activation link`, and open `/user/password/set` to set the user's password.

## 4. Optional Modules

### 4.1 FlashTeX Continuous Hot Preview (`热` Mode)
- Source files live in `tools/flash-preview/` (`service.py`, `worker.py`, `controller.mjs`, `preview.js`).
- Run `service.py` as a user systemd service listening on `~/.local/share/overleaf-flash-preview/ipc/worker.sock` and mount that directory read-only to `/run/flash-preview` in `compose.yml`.
- Formal PDF export remains on Overleaf's native `pdfLaTeX`.

### 4.2 LocalAi Sidebar & Inline Completion
- Set `OPENAI_API_KEY`, `OVERLEAF_AI_MODEL`, `OVERLEAF_AI_REASONING_EFFORT`, and optional `OVERLEAF_AI_HTTPS_PROXY` in the `app` environment.
- Never expose API keys to browser code; all requests go through `/project/:Project_id/local-ai`.

### 4.3 HTTPS Reverse Proxy, FRP & Local Proxy Bypass
- Terminate TLS in Nginx with WebSocket headers (`Upgrade`, `Connection`), `proxy_read_timeout 3600s`, `proxy_buffering off`, and block `/launchpad`, `/register`, `/signup` on public listeners.
- If using Clash/system proxy on the host, add your Overleaf domain to `/etc/hosts` (`127.0.0.1`), Clash `DIRECT` rules, and GNOME/system `ignore-hosts` so local traffic does not loop through the proxy or public tunnel.
