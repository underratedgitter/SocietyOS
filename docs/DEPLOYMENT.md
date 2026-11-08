# Deployment guide

This guide describes a single-host Docker Compose deployment behind a TLS
terminator. It is the supported topology for the pilot: one API instance, one
web instance, one PostgreSQL primary, Redis and Mosquitto on a private Docker
network.

For a multi-tenant SaaS rollout, replace the single host pieces with a managed
PostgreSQL, managed Redis, a per-device MQTT broker identity and an orchestrator
that can run more than one API replica (see [Scaling limits](#scaling-limits)).

## Topology

```text
Internet / society LAN
        |
   TLS terminator (load balancer, Cloudflare Tunnel, Caddy or Nginx with certs)
        |  HTTP :80
   +----+--------------------------------------------------+
   | nginx (compose)                                       |
   |   /            -> web:3000  (Next.js standalone)      |
   |   /api/        -> api:4000  (NestJS)                  |
   |   /healthz     -> api:4000/api/v1/healthz             |
   +----+----------------+----------------+----------------+
        |                |                |
      api:4000         web:3000        (no host ports)
        |
   postgres:5432   redis:6379   mosquitto:1883
```

Only Nginx publishes a host port (`80` by default). PostgreSQL, Redis and
Mosquitto are reachable only on the compose network. Nginx restores the client
address from the TLS terminator's `X-Forwarded-For` (see
[Client IPs](#client-ips-behind-the-terminator)) and forwards a single
resolved address; the API trusts that one hop (`trust proxy = 1`) so client
IPs, rate limits and secure-cookie decisions are correct.

## Prerequisites

- A Linux host with Docker Engine 25+ and the Compose plugin.
- 2 vCPU / 4 GB RAM minimum for the pilot; 4 vCPU / 8 GB recommended.
- A DNS name pointing at the host and a TLS certificate for it.
- Outbound access for image pulls and, if configured, the notification webhook.

## 1. Configure secrets

```bash
cp .env.production.example .env.production
chmod 600 .env.production
```

Fill every value. Generate high-entropy secrets rather than inventing them:

```bash
openssl rand -hex 32   # JWT_ACCESS_SECRET
openssl rand -hex 32   # CREDENTIAL_HMAC_KEY
openssl rand -base64 32 # DEVICE_SECRET_ENC_KEY (must decode to exactly 32 bytes)
openssl rand -hex 24   # POSTGRES_PASSWORD
openssl rand -hex 24   # Redis password (secret file + REDIS_URL, below)
openssl rand -hex 24   # MQTT_API_PASSWORD
openssl rand -hex 24   # MQTT_DEVICE_PASSWORD
openssl rand -hex 32   # NOTIFICATION_WEBHOOK_SECRET
```

Rules enforced by the API at startup:

- `NODE_ENV=production` requires `WEB_URL` to be an `https://` URL.
- `JWT_ACCESS_SECRET` and `CREDENTIAL_HMAC_KEY` must be at least 32 characters
  and must not contain the development placeholders.
- `DEVICE_SECRET_ENC_KEY`, when set, must be 32 bytes of base64. If it is
  omitted the key is derived from `CREDENTIAL_HMAC_KEY`; set it explicitly so
  rotating the HMAC key does not make stored device secrets unreadable.

Redis requires a password. It is read from a secret file so the Redis
container never sees the other values in `.env.production`; the API reads the
same password from `REDIS_URL`:

```bash
mkdir -p infrastructure/docker/redis
openssl rand -hex 24 > infrastructure/docker/redis/password
chmod 600 infrastructure/docker/redis/password
# in .env.production (hex passwords need no URL escaping):
# REDIS_URL=redis://:<contents of the password file>@redis:6379
```

If the two disagree the API logs `NOAUTH`/`WRONGPASS`, `readyz` reports
`redis: degraded` and rate limiting silently falls back to per-process memory.

Keep `.env.production` out of git (it is ignored). Back it up in your secret
manager; losing `CREDENTIAL_HMAC_KEY` invalidates every issued credential hash,
and losing `DEVICE_SECRET_ENC_KEY` makes stored device command secrets
unreadable.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string used by the API and migrations |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | yes | Credentials for the bundled PostgreSQL container |
| `WEB_URL` | yes | Public HTTPS origin; used for CORS, cookies and links |
| `APP_BASE_URL` | no | Base URL in notifications; defaults to `WEB_URL` |
| `JWT_ACCESS_SECRET` | yes | Signs access tokens (32+ chars) |
| `JWT_ISSUER` / `JWT_AUDIENCE` | no | Token `iss`/`aud`; default `societyos-api` / `societyos-clients` |
| `CREDENTIAL_HMAC_KEY` | yes | Keyed hash for PIN/QR credentials (32+ chars) |
| `CREDENTIAL_HMAC_KEY_ID` | no | Key version stored with each hash; default `v1` |
| `DEVICE_SECRET_ENC_KEY` | recommended | Base64 32-byte key that encrypts device command secrets |
| `REDIS_URL` | yes (prod stack) | `redis://:<password>@redis:6379`; password must match `infrastructure/docker/redis/password`. Unset or wrong falls back to per-process rate limiting |
| `MQTT_URL` | no | Broker URL, e.g. `mqtt://mosquitto:1883`; devices degrade without it |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | with MQTT | Broker identity for the API |
| `MQTT_TLS_REJECT_UNAUTHORIZED` | no | Set `false` only for a self-signed broker certificate |
| `COOKIE_SECURE` | no | Defaults to `true` in production; keep it true |
| `ENABLE_SWAGGER` | no | Defaults to `false` in production |
| `RATE_LIMIT_ENABLED` | no | Defaults to `true` |
| `CORS_ORIGINS` | no | Extra comma-separated origins; `WEB_URL` is always allowed |
| `NOTIFICATION_WEBHOOK_URL` / `NOTIFICATION_WEBHOOK_SECRET` | no | Outbound notification delivery |
| `SMS_PROVIDER` / `TWILIO_*` / `MSG91_*` | no | Automated SMS delivery (`twilio`, `msg91`, or `mock`) |
| `WHATSAPP_PROVIDER` / `WHATSAPP_*` | no | WhatsApp Business / Twilio WhatsApp delivery |
| `EXPO_ACCESS_TOKEN` / `WEB_PUSH_*` | no | Mobile Expo Push and Web Push notification delivery |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` | no | Razorpay order creation, signature verification and webhook verification |
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` / `STRIPE_WEBHOOK_SECRET` | no | Stripe payment intent creation & webhook processing |
| `API_PORT` | no | API listen port, `4000` in the image |
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_NAME` | no | Defaults for `dist/cli/bootstrap-admin.js` when flags are omitted |

Set outside `.env.production`:

| Variable | Where | Purpose |
| --- | --- | --- |
| `API_INTERNAL_URL` | web image build arg (compose sets `http://api:4000`) | Target of the Next.js `/api/v1` rewrite. Baked in at build time; changing it at runtime has no effect |
| `NGINX_HTTP_BIND` | shell or `./.env` when running compose | Host bind for Nginx, default `80`. Use `127.0.0.1:80` when the TLS terminator runs on the same host |

## 2. Generate broker credentials

Mosquitto refuses to start without the mounted password and ACL files; create
them before the first `up`:

```bash
MQTT_API_PASSWORD='...' MQTT_DEVICE_PASSWORD='...' \
  sh infrastructure/scripts/generate-mqtt-credentials.sh
```

The script writes `infrastructure/docker/mosquitto/passwd` and `acl` with mode
`600`, owned by the broker's `mosquitto` user (uid 1883) so the broker can read
them after dropping root; both are git-ignored. Use `sudo` to copy them into
your secret manager. The ACL gives the API read/write on `society/#`
and gives devices access only to their own command, acknowledgement, event,
health and telemetry topics.

The bundled broker listens on plaintext `1883` inside the private network only.
If controllers connect over an untrusted network, either terminate MQTT TLS at
a broker/load balancer in front of it or add an `8883` listener with
certificates to `mosquitto.prod.conf`.

## 3. Build and start

```bash
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```

The API image applies `prisma migrate deploy` on start, then serves. It never
runs `prisma migrate dev`. No seed
runs in production; demo accounts and fixture credentials must never be created
there. Create the first platform administrator explicitly:

```bash
docker compose -f docker-compose.prod.yml exec api \
  node dist/cli/bootstrap-admin.js --email ops@example.com --name "Operations"
```

The command prints a one-time temporary password (the account must change it at
first sign-in) and writes a `PLATFORM_ADMIN_BOOTSTRAPPED` audit entry. It never
modifies an existing user; re-running it for the same email fails safely.

Verify:

```bash
curl -fsS http://localhost/healthz
curl -fsS http://localhost/api/v1/readyz
```

`readyz` returns `503` when PostgreSQL is unreachable. `redis` and `mqtt`
report `degraded` rather than failing readiness, because both have documented
fallbacks.

## 4. Terminate TLS

Nginx in this stack serves HTTP only, so put one of the following in front of
port 80:

- A load balancer or ingress that terminates TLS and forwards
  `X-Forwarded-Proto: https`.
- Cloudflare Tunnel, which forwards the public hostname to `nginx:80`.
- Caddy or another Nginx with certificates, proxying to `127.0.0.1:80`.

Keep `WEB_URL` set to the public `https://` origin. Secure cookies are enabled
by default in production; the browser sees only the TLS origin, so they work.

When the terminator runs on the same host, bind Nginx to loopback so plaintext
`:80` is not reachable from the internet:

```bash
echo 'NGINX_HTTP_BIND=127.0.0.1:80' >> .env   # compose interpolation file
```

### Client IPs behind the terminator

`infrastructure/nginx/nginx.conf` trusts `X-Forwarded-For` only from private
ranges (`10/8`, `172.16/12`, `192.168/16`, `127.0.0.1`), which covers Docker
bridges, `cloudflared` and VPC load balancers. Narrow `set_real_ip_from` to
your terminator's address if clients on the society LAN reach Nginx directly,
since they could otherwise spoof their address and dodge per-IP rate limits.
If a CDN proxies to a public IP, add the CDN's published ranges. Verify by
checking that `/api/` access log lines show real client IPs, not the
terminator's.

### Terminating TLS on the compose Nginx

If you must terminate TLS on the compose Nginx itself, mount the certificate,
publish `443:443`, turn the port 80 server into a redirect and add:

```nginx
server {
  listen 443 ssl;
  http2 on;
  server_name app.example.com;
  ssl_certificate     /etc/nginx/certs/fullchain.pem;
  ssl_certificate_key /etc/nginx/certs/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_prefer_server_ciphers off;
  ssl_session_cache shared:TLS:10m;
  ssl_session_tickets off;
  # ...same add_header and location blocks as the port 80 server...
}
```

HSTS (`max-age=31536000; includeSubDomains`) is sent by Nginx for web routes
and by the API (helmet) for `/api/`; it only takes effect once browsers reach
the site over HTTPS.

## 5. Backups

```bash
BACKUP_DIR=/var/backups/societyos RETENTION_DAYS=30 \
  sh infrastructure/scripts/backup-postgres.sh
```

The script writes a custom-format `pg_dump` to a `.partial` file, checks it
with `pg_restore --list`, then renames it (mode `600`, directory `700`) and
prunes dumps older than the retention window. A failed or truncated dump
exits non-zero and never replaces or prunes existing backups. The database
user and name come from `.env.production` (`POSTGRES_USER`/`POSTGRES_DB`).
Example cron entry (cron has a minimal `PATH`, so make sure `docker` is on it):

```cron
15 2 * * * cd /opt/societyos && BACKUP_DIR=/var/backups/societyos RETENTION_DAYS=30 /bin/sh infrastructure/scripts/backup-postgres.sh >> /var/log/societyos-backup.log 2>&1
```
 Schedule it from cron or a systemd timer and
copy dumps off the host. Redis is a cache and Mosquitto persistence only holds
in-flight broker state, so PostgreSQL is the only data that must be backed up.

Restore is destructive and guarded:

```bash
CONFIRM_RESTORE=yes sh infrastructure/scripts/restore-postgres.sh \
  /var/backups/societyos/societyos-20261030T020000Z.dump
```

It stops `api` and `web`, runs `pg_restore --clean --if-exists` in a single
transaction, then restarts them. If any statement fails the whole restore rolls
back to the previous state and `api`/`web` stay stopped until you start them. Rehearse a restore before go-live and after every schema change.

## 6. Upgrades and rollback

```bash
git pull
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
```

Migrations are forward-only. Before an upgrade that includes a migration, take a
backup. To roll back application code, check out the previous revision, rebuild
and start; the database schema must still be compatible. If a migration itself
is faulty, restore the pre-upgrade dump instead of hand-editing the schema.

Tag images before replacing them so rollback does not depend on a rebuild:

```bash
docker tag societyos-prod-api:latest societyos-api:2026-10-30
docker tag societyos-prod-web:latest societyos-web:2026-10-30
```

## 7. Health and logs

- `GET /healthz` — liveness, no dependencies.
- `GET /api/v1/readyz` — PostgreSQL plus Redis/MQTT component status.
- `docker compose -f docker-compose.prod.yml ps` — container health checks.
- `docker compose -f docker-compose.prod.yml logs -f api web nginx` — service
  logs. The API logs one line per 5xx with the request ID; clients receive the
  same `x-request-id`, which is also the `requestId` in error responses.

Point your uptime monitor at `/healthz` and an alert at `/api/v1/readyz`
returning non-200. A `degraded` broker or Redis shows up in `readyz` and should
page only if gate verification is affected.

## Scaling limits

The pilot stack is deliberately single-instance:

- The maintenance sweep (`MaintenanceService`) runs in-process in every API
  replica. Its updates are idempotent, but move it to a queue with a
  distributed lock before running several replicas.
- MQTT subscriptions assume one API consumer. Multiple replicas would each
  receive acknowledgements; make ack handling idempotent or dedicate a worker.
- Rate limiting uses Redis when configured and a per-process memory limiter
  otherwise; always set `REDIS_URL` when scaling.
- Sessions, idempotency records and passes live in PostgreSQL, so they are
  already shared.

For a wider rollout, also replace the shared `societyos-device` broker identity
with one credential per controller (see the operations runbook).

## Preview stack

To exercise the real images locally without TLS:

```bash
cp .env.production.example .env.production
# set real secrets in .env.production, generate broker credentials and the
# Redis password file (steps 1 and 2)
docker compose -f docker-compose.prod.yml -f docker-compose.preview.yml \
  up -d --build
docker compose -f docker-compose.prod.yml -f docker-compose.preview.yml \
  exec -T api node_modules/.bin/tsx prisma/seed.ts
```

The preview overlay sets `NODE_ENV=development`, lowers the HTTPS-only check and
mounts `apps/api/src` so the TypeScript seed can run. Never expose it publicly.
