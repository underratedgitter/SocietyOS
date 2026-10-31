# SocietyOS

SocietyOS is a residential society management and gate access control system. Residents issue time-limited visitor passes as a six-digit PIN or a high-entropy QR token. Guards, a virtual kiosk and physical controllers verify those credentials server-side, and every decision is written to an append-only access log.

The stack is a pnpm workspace:

| App | Port | What it is |
| --- | --- | --- |
| `apps/web` | 3000 | Next.js 16 app: admin, resident, guard console and full-screen kiosk |
| `apps/api` | 4000 | NestJS modular monolith with Prisma, Swagger and MQTT |
| `apps/device-simulator` | — | Virtual gate controller with a signable-command state machine |

PostgreSQL stores tenants and passes, Redis backs rate limiting, and Mosquitto carries signed gate commands over MQTT. The API still runs without Redis (in-memory limiter) and without MQTT (controller verification returns `CONTROLLER_UNAVAILABLE` instead of opening a gate).

## Prerequisites

- Node.js 22+
- pnpm 12.15+ (`corepack enable` picks up the pinned `packageManager`)
- Docker Desktop (or local PostgreSQL, Redis and Mosquitto)

## Project layout

```text
apps/api/               NestJS API, Prisma schema, migrations, seed and tests
apps/web/               Next.js app (admin, resident, guard, kiosk) and Playwright tests
apps/device-simulator/  Virtual gate controller
infrastructure/         Nginx, Mosquitto and operational scripts
packages/               Shared workspace packages
docker-compose.yml      Local development dependencies
docker-compose.prod.yml Production container stack
docs/                   Deployment, operations and requirements

## Setup

```bash
# 1. Local infrastructure
docker compose up -d

# 2. Environment
cp .env.example .env

# 3. Dependencies
pnpm install

# 4. Schema and demo data
pnpm --filter @societyos/api db:generate
pnpm --filter @societyos/api db:deploy
pnpm db:seed

# 5. Run the API and web app in separate terminals
pnpm dev:api
pnpm dev:web
```

Open <http://localhost:3000>. The API exposes Swagger at <http://localhost:4000/api/docs>, a liveness probe at `/api/v1/healthz` and a readiness probe at `/api/v1/readyz`.

The seed is idempotent: every run refreshes the demo users, structure and documented pass fixtures (including their PINs and statuses), so rehearsals start from the same state. It prints the simulator token and command secret at the end.

## Demo accounts

| Role | Email | Password |
| --- | --- | --- |
| Platform operator | `platform@societyos.dev` | `Platform#2026` |
| Palm Grove admin | `admin.a@societyos.dev` | `AdminA#2026` |
| Harbour admin | `admin.b@societyos.dev` | `AdminB#2026` |
| Palm Grove guard | `guard.a@societyos.dev` | `GuardA#2026` |
| Palm Grove resident | `resident.a1@societyos.dev` | `Society#2026` |
| Harbour resident | `resident.b1@societyos.dev` | `Society#2026` |

Demo visitor credentials for Palm Grove: PIN `123456` (active, two entries), PIN `222222` (delivery awaiting approval), PIN `654321` (Harbour). The seeded pass fixtures also include expired, revoked and exhausted examples for negative testing.

The admin console is at `/admin`, the resident workspace at `/resident`, the guard console at `/guard`, and the kiosk at `/kiosk`.

## Virtual gate controller

The simulator authenticates with the device token, discovers its gates, sends heartbeats, listens for HMAC-signed commands, simulates barrier motion and acknowledges each command with a signed message. It can also drive the normal visitor flow:

```bash
DEVICE_TOKEN=sos_dev_demo_simulator_token_a_change_me_2026 \
COMMAND_SECRET=demo-command-secret-a-change-me-2026 \
pnpm dev:simulator
```

The simulator reads `API_URL`, `MQTT_URL`, `DEVICE_TOKEN`, `COMMAND_SECRET` and optionally `ACCESS_POINT_ID`, `HEARTBEAT_SECONDS` and `GATE_MOTION_MS`. Once it is running:

```text
sim> pin 123456
sim> qr demo-qr-token-a1
sim> state
```

`pin 123456` uses the device-authenticated endpoint (`POST /api/v1/access/verify`) and, if the pass is valid, the API publishes a signed `OPEN` command that the simulator executes. A second use exhausts the seeded two-entry pass.

To rotate credentials, use the admin console under **Gates & devices**, then restart the simulator with the new values.

## Product flows

1. **Tenant setup** — a platform operator creates a society and its first administrator. The administrator adds buildings, flats, residents, guards, access points and controllers.
2. **Invite** — a resident picks a visitor, category, arrival window, gate and use limit. The API applies the society policy, hashes the PIN/QR at rest and returns the plaintext credential exactly once.
3. **Approve** — categories marked in the policy (`DELIVERY` and `CAB` by default) start as `PENDING_APPROVAL`. A resident, guard or admin approves or rejects the pass; rejection revokes it.
4. **Verify** — a guard enters the PIN on the kiosk, scans/pastes the QR token, or a controller posts to the device API. The engine checks scope, gate assignment, approval, window, remaining uses and revocation, then consumes one use atomically and records an `AccessEvent`. Devices additionally receive a signed `OPEN` command.
5. **Audit** — every admin mutation and access decision is append-only and visible in the admin log and guard entry log.

## Security properties

- Access and refresh tokens are HTTP-only cookies; passwords use bcrypt and force rotation for invited users.
- Tenant scope is enforced by guards and service-level lookups, not by trusting IDs from the client.
- Credentials are stored as keyed HMAC hashes. Plaintext PINs and QR tokens exist only in the issuance response.
- Redemption is a conditional `UPDATE ... WHERE usedCount < maxUses` inside a transaction; concurrent attempts cannot double-spend a pass.
- Device commands are HMAC-signed, nonce-bound, expire in 30 seconds, and are checked against the device/gate assignment on both sides.
- Verification is rate-limited per device, per credential and per guard; repeated failures create a security alert.
- The web app sets CSP, frame denial, `nosniff` and a strict referrer policy, and never exposes credential secrets after issuance.

## Tests

```bash
# Fast unit tests (no database)
pnpm test

# Database-backed integration tests: auth, tenant isolation, approval, replay and concurrency
pnpm --filter @societyos/api test:e2e

# Include the live MQTT command/acknowledgement protocol test (requires Mosquitto)
MQTT_TEST_URL=mqtt://localhost:1883 pnpm --filter @societyos/api test:e2e

# Browser workflows: resident invites, guard verifies, kiosk denies, admin loads settings
pnpm --filter @societyos/web exec playwright install chromium
pnpm --filter @societyos/web test:e2e
```

The browser suite expects the API and web app to be running and the demo data to exist. Run `pnpm dev:api` and `pnpm dev:web` in separate terminals first. On a reused local database, use the destructive `pnpm db:reset` to return to a clean seeded state.

The API integration suite covers cookie sessions and refresh-token rotation, CSRF origin rejection, forced password rotation, tenant onboarding, role and cross-society isolation, device provisioning/rotation/disable, controller-outage compensation, idempotent verification and concurrent redemption. The protocol suite is skipped unless `MQTT_TEST_URL` is set; CI starts an anonymous Mosquitto broker and runs it so the HMAC-signed command and acknowledgement wire contract is exercised on every build.

## Container preview

The full stack (PostgreSQL, Redis, authenticated Mosquitto, API, web and Nginx) can be exercised locally through the preview overlay. It keeps the production images and proxy topology but relaxes the HTTPS-only configuration check.

```bash
cp .env.production.example .env.production
# Replace every secret and password in .env.production first.
MQTT_API_PASSWORD='...' MQTT_DEVICE_PASSWORD='...' \
  sh infrastructure/scripts/generate-mqtt-credentials.sh

docker compose -f docker-compose.prod.yml -f docker-compose.preview.yml up -d --build
docker compose -f docker-compose.prod.yml -f docker-compose.preview.yml \
  exec -T api node_modules/.bin/tsx prisma/seed.ts
```

Open <http://localhost>. The preview is for local verification only; production requires HTTPS and a managed database/broker per the deployment guide.

## Deployment and operations

- [Deployment guide](docs/DEPLOYMENT.md) — TLS, secrets, container stack, migrations and backups.
- [Operations runbook](docs/RUNBOOK.md) — broker/API outages, stuck gates, lost devices and credential compromise.
- [Architecture](docs/ARCHITECTURE.md) — modules, data model, authorization and command signing.
- [Security policy](SECURITY.md) — reporting and known deployment limitations.

## Useful commands

```bash
pnpm typecheck                 # API, web and simulator
pnpm --filter @societyos/web build
pnpm --filter @societyos/api build
pnpm --filter @societyos/api test
pnpm db:reset                  # destructive: recreates and reseeds a local database
```

## Project documents

The implementation blueprint and the original biometric gate brief live in `docs/requirements/`. Biometric entry is deliberately out of scope for this release; the database and access engine are structured so an additional credential type can be added without changing the pass model.
