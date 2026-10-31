# Architecture

SocietyOS is a modular monolith with a Next.js frontend, a NestJS API and one
PostgreSQL database. Redis and MQTT are supporting services with documented
fallbacks. This document describes how the pieces fit together; deployment and
capacity notes are in [DEPLOYMENT.md](DEPLOYMENT.md), and incident procedures
are in [RUNBOOK.md](RUNBOOK.md).

## System shape

```text
Browser (admin / resident / guard / kiosk)
        |
        | same-origin HTTPS
        v
Next.js app (app router, server-rendered shell)
        |
        | /api/v1/* rewrite (API_INTERNAL_URL)
        v
NestJS API  ---> PostgreSQL (system of record)
   |    |   \
   |    |    +--> Redis (rate limits, optional)
   |    +-------> notification outbox --> webhook / provider
   +------------> Mosquitto --> gate controllers
                        ^
                        | signed commands + signed acknowledgements
```

The browser never holds access or refresh tokens in JavaScript-readable state:
both are HTTP-only cookies issued by the API. The web app proxies `/api/v1/*`
through a Next.js rewrite so browsers see a single origin, which keeps
`SameSite=Strict` cookies and CORS simple.

The pilot runs one API process. PostgreSQL is the only shared source of truth;
Redis is a cache for rate limiting and can be lost. MQTT carries commands but
is never the system of record: every command, acknowledgement and access
decision is persisted first.

## Workspace layout

```text
apps/api/                 NestJS API, Prisma schema/migrations, seed, Jest tests
  src/auth/               Login, cookies, sessions, JWT and scope guards
  src/societies/          Tenant setup, people, structure, policy, dashboards
  src/visitors/           Visitor passes, approvals, credentials
  src/devices/            Access points, devices, MQTT, command views
  src/access/             Verification engine and HTTP endpoints
  src/notifications/      Durable notification outbox
  src/common/             Prisma, authz, audit, rate limit, crypto, maintenance
apps/web/                 Next.js app router pages and Playwright workflows
apps/device-simulator/    Virtual controller for local end-to-end testing
infrastructure/           Nginx, Mosquitto config and backup/restore scripts
packages/                 Shared workspace packages
docs/                     Deployment, operations and architecture
```

## API composition

All routes live under `/api/v1`. Swagger is exposed at `/api/docs` outside
production (`ENABLE_SWAGGER=true` overrides it).

| Module | Responsibility |
| --- | --- |
| `AuthModule` | Password sign-in, rotating refresh sessions, logout, password change, `/auth/me` |
| `SocietiesModule` | Platform onboarding, societies, buildings, flats, residents, staff, visitor policy, overview, audit and security alerts |
| `VisitorsModule` | Pass creation, approval/rejection, revocation, listing, credential issuance |
| `DevicesModule` | Access points, device provisioning and rotation, enable/disable, health, event and command history |
| `AccessModule` | Device-authenticated verify, guard manual verify, decision engine |
| `NotificationsModule` | Transactional outbox drained in the background |
| `HealthController` | `/healthz` liveness and `/readyz` dependency readiness |

`main.ts` configures the cross-cutting pipeline:

1. Helmet headers, no `X-Powered-By`, 100 KB JSON body limit.
2. A validated `x-request-id` (supplied or generated) echoed on the response and
   included in every error envelope.
3. CORS with an explicit allowlist (`WEB_URL` plus `CORS_ORIGINS`), credentials
   enabled.
4. A global `ValidationPipe` with `whitelist`, `transform` and
   `forbidNonWhitelisted`, so unknown fields are rejected rather than ignored.
5. A global exception filter that maps every failure to
   `{ code, message, requestId, details? }` and logs server errors with the
   request ID.
6. Global prefix `api/v1`, shutdown hooks and, in production, `trust proxy = 1`
   so Nginx-forwarded client IPs are used correctly.

Services receive the caller from the verified JWT and always re-check the
resource against the tenant. Route-level guards (`JwtAuthGuard`,
`SocietyScopeGuard`, `FlatScopeGuard`, `DeviceAuthGuard`) are an outer layer,
not the only control.

## Authentication and authorization

- Passwords are bcrypt hashes (cost 12). Unknown emails are compared against a
  dummy hash so login timing does not reveal account existence.
- A successful login creates a `Session` row. The refresh token is random and
  stored only as a SHA-256 hash; it rotates on every refresh, and the old row is
  revoked in the same transaction. Reuse of a rotated token fails.
- Access tokens are HS256 JWTs with issuer/audience checks and a 15-minute TTL.
  `JwtAuthGuard` reloads the user from PostgreSQL on every request so a disabled
  account or a forced password change takes effect immediately.
- Cookies are `HttpOnly`, `SameSite=Strict`, `Secure` in production, named
  `sos_at` and `sos_rt`. Mutating cookie-authenticated requests with an
  `Origin` header must match the configured origin (CSRF defense); bearer
  tokens are used by devices and API clients.
- Roles are `PLATFORM_ADMIN`, `SOCIETY_ADMIN`, `RESIDENT` and `GUARD`, stored per
  society in `SocietyMembership`. Platform admin is a user flag plus platform
  membership, not a superuser bypass inside a society's data.
- Residents are scoped to flats through `ResidentFlatMembership`; guard
  verification is scoped to the access point's society.
- Users with `mustChangePassword` can only call `/auth/me`, `/auth/logout` and
  `/auth/change-password` until they rotate the temporary password.

## Visitor pass lifecycle

1. A resident creates a pass for a flat, visitor, category, window, use limit
   and one or more access points. Society policy (`VisitorPolicy`) decides the
   maximum window, whether approval is required and which categories are
   allowed.
2. The API generates a six-digit PIN and a 24-byte base64url QR token, stores
   only keyed HMAC-SHA256 hashes (`VisitorPassCredential`), and returns the
   plaintext once in the creation response.
3. `DELIVERY` and `CAB` default to `PENDING_APPROVAL`. A resident, guard or admin
   approves or rejects; rejection revokes the pass.
4. A guard or device presents the PIN/QR to the access engine. A successful use
   increments `usedCount`, writes a `VisitorPassUse` redemption and an
   `AccessEvent`, and for devices creates a signed `GateCommand`.
5. The maintenance sweep expires passes past `validUntil`, marks exhausted
   passes, expires stale commands, and prunes old idempotency and session rows.

Status is derived carefully because stored status and time can disagree:
`effectiveStatus` accounts for expiry, exhaustion and revocation, while the
access engine still re-checks the window and use count inside the transaction.

## Access decision engine

`AccessEngineService.verify()` is the only path that consumes a pass.

1. **Idempotency** — keyed by actor (device ID or guard user ID) and the
   supplied `requestId`. A duplicate returns the stored response; the same key
   with a different credential hash returns `IDEMPOTENCY_PAYLOAD_MISMATCH`.
   Records expire after 10 minutes.
2. **Rate limits** — 60 attempts/minute per device or guard and 15 attempts per
   15 minutes per credential hash. Credential throttling also writes a
   `CREDENTIAL_BRUTE_FORCE` security alert.
3. **Transaction** — validates the access point and device scope, loads the
   credential hash, and checks society, gate assignment, revocation, approval,
   validity window and remaining uses. For devices it also requires a live
   command secret.
4. **Atomic consumption** — `UPDATE visitor_pass SET usedCount = usedCount + 1
   WHERE usedCount < maxUses AND validFrom <= now AND validUntil >= now AND
   status = 'ACTIVE'`. Only one concurrent attempt can match; the others get a
   reason code based on a fresh read. This is the anti-double-spend boundary,
   not an application-level `if`.
5. **Record and dispatch** — writes the redemption, access event and (for
   devices) an `ISSUED` gate command in the same transaction. After commit, a
   device command is published over MQTT with QoS 1 and its signed payload is
   stored.
6. **Compensation** — if MQTT dispatch fails, the engine expires the command,
   deletes the redemption, decrements `usedCount` and records a separate
   `CONTROLLER_UNAVAILABLE` denial. A failed delivery therefore does not burn a
   visit.
7. **Notification** — an authorized entry enqueues `VISITOR_ARRIVED` for the
   host in the outbox; delivery failure never rolls back the access decision.

Denial reason codes are stable identifiers (`PASS_EXPIRED`, `PASS_REVOKED`,
`PASS_ALREADY_USED`, `WRONG_ACCESS_POINT`, `WRONG_SOCIETY`,
`APPROVAL_REQUIRED`, `DEVICE_DISABLED`, `RATE_LIMIT_EXCEEDED`,
`CONTROLLER_UNAVAILABLE`, `INVALID_CREDENTIAL`, `INTERNAL_ERROR`). The UI shows
a safe message; the log keeps the code.

## Device protocol

A device authenticates with `Authorization: Bearer sos_dev_...` to
`POST /api/v1/access/verify`. Provisioning returns the token and a command
secret once. The token is stored as SHA-256; the command secret is encrypted at
rest with AES-256-GCM under `DEVICE_SECRET_ENC_KEY` (or a key derived from
`CREDENTIAL_HMAC_KEY` when unset).

Topics are scoped to the society and device:

```text
society/<societyId>/device/<deviceId>/commands
society/<societyId>/device/<deviceId>/acknowledgements
society/<societyId>/device/<deviceId>/events
society/<societyId>/device/<deviceId>/health
society/<societyId>/device/<deviceId>/telemetry
```

Commands carry `{ commandId, deviceId, accessPointId, type, nonce, issuedAt,
expiresAt, signature }`. The signature is HMAC-SHA256 over a canonical
newline-delimited string (`societyos-command-v1`, all fields in order). Commands
expire after 30 seconds and are only published for an `ISSUED` row whose device
is `ACTIVE` and still linked to the access point. Acks use a separate canonical
string (`societyos-ack-v1`) and are checked for device/society scope, the
command nonce, the current unrevoked command secret and a valid signature.
Ack status can only move `ISSUED`/`ACKNOWLEDGED` → `ACKNOWLEDGED`, `EXECUTED` or
`FAILED`; a scope or signature mismatch is logged and dropped.

The broker's production ACL gives the API read/write on `society/#` and devices
write access only to their own topics. The bundled broker is plaintext inside
the private Docker network; controllers on an untrusted network must use TLS
(see the deployment guide).

## Data model

PostgreSQL owns every durable fact. UUID primary keys are used throughout, and
society-owned tables carry `societyId` so tenant filters are explicit and
indexable.

| Area | Tables |
| --- | --- |
| Identity | `User`, `Session`, `SocietyMembership`, `ResidentFlatMembership` |
| Tenant structure | `Society`, `Building`, `Flat`, `VisitorPolicy` |
| Visitors | `Visitor`, `VisitorPass`, `VisitorPassCredential`, `VisitorPassAccessPoint`, `VisitorApproval`, `VisitorPassUse` |
| Devices | `AccessPoint`, `Device`, `DeviceCredential`, `DeviceAccessPoint`, `GateCommand`, `DeviceEvent`, `DeviceHealthLog` |
| Audit and control | `AccessEvent`, `AuditLog`, `SecurityAlert`, `Notification`, `IdempotencyRecord` |

Credentials are unique by hash and typed (`PIN` or `QR`). Device credentials
are revocable rows rather than a single mutable secret, so rotation keeps an
audit trail and old tokens stop authenticating immediately. `GateCommand`
stores the nonce, expiry, status, signed payload and execution state. Every
admin mutation goes through `AuditService`, and every access attempt — allowed
or denied — writes an `AccessEvent` with the request ID and source.

## Web application

The Next.js app router renders the platform console, admin console, resident
workspace, guard console and kiosk. There is no separate web API layer:
components call `/api/v1/*` on the same origin, and `next.config.ts` rewrites
that prefix to `API_INTERNAL_URL`. `lib/api.ts` adds a single-flight refresh on
401, retries the original request once, and dispatches an unauthorized event
when refresh fails. Tokens never reach client JavaScript.

Pages are client-rendered shells with role-aware navigation (`app-shell.tsx`)
and a `Protected` wrapper; authorization is still enforced by the API. The
kiosk is intentionally minimal and designed for a full-screen gate terminal.
CSP, frame denial, `nosniff`, referrer policy and a permissions policy are set
in `next.config.ts`; the kiosk enables camera only for QR scanning.

## Background work

Two in-process loops keep the pilot simple:

- `MaintenanceService` runs every 15 seconds and only performs idempotent,
  deadline-driven updates. It never opens a gate.
- `NotificationsService` drains a PostgreSQL outbox every 5 seconds, claiming
  rows with a conditional update, retrying with linear backoff and capping at
  five attempts. Delivery uses an HMAC-signed webhook if configured; otherwise
  the notification remains durable and is logged.

Before running multiple API replicas, move both loops to a queue with a
distributed lock and make MQTT acknowledgement handling single-consumer or
idempotent. The deployment guide lists the other scaling limits.

## Testing strategy

- **Unit tests** cover pass status derivation, credential hashing, visitor
  policy and other pure logic; they need no database.
- **Integration tests** boot the real `AppModule` against PostgreSQL and the
  seeded demo tenants. They cover cookie auth and refresh rotation, CSRF origin
  rejection, forced password rotation, tenant onboarding, tenant and role
  isolation, approval, revocation, wrong-gate denial, unknown credentials,
  device provisioning/rotation/disable, controller-outage compensation and a
  six-way concurrent redemption that must yield exactly one authorization.
- **Protocol tests** connect to a real Mosquitto broker, provision a device,
  receive the signed `OPEN` command, verify its HMAC, publish signed and
  tampered acknowledgements, and assert the persisted command state. The suite
  is skipped unless `MQTT_TEST_URL` is configured.
- **Browser tests** (Playwright) drive the resident invite flow, guard
  verification, kiosk denial and admin settings across a live API and web app.
- **CI** starts PostgreSQL, Redis and Mosquitto, runs migrations and the seed,
  typechecks, runs unit and integration tests, builds both apps, runs the
  Playwright suite, and builds both container images.

## Deliberate boundaries

- Biometric entry is out of scope. The credential table and access engine are
  typed so a new credential kind can be added without changing the pass model.
- The API is a modular monolith, not microservices. Tenant isolation and
  transactional redemption are simpler to prove in one process and one
  database.
- There is no separate message bus between modules; the outbox and persisted
  command rows provide the durable hand-offs.
- The pilot does not include SSO, MFA, per-device broker identities or
  multi-region failover. Those are tracked as deployment limitations rather
  than implied capabilities.
