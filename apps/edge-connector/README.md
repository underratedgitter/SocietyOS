# SocietyOS Edge Connector

Small Node service that runs on a PC or server at the society, next to the biometric terminals. It reads punches
from the vendor's own database (or from BioStar 2's REST API) and forwards them to the SocietyOS cloud. It never
matches biometrics and never writes to the vendor database.

```
terminal -> vendor software -> vendor SQL DB -> [edge-connector] -> SocietyOS cloud API
```

Cloud endpoints used (all with `Authorization: Bearer <device token>`):
`POST /api/v1/device-api/biometric-events` (max 500 per call), `GET /api/v1/device-api/sync-commands`,
`POST /api/v1/device-api/sync-commands/:id/ack`.

## Status of vendor knowledge

Do not trust any table or column that is not marked confirmed. Anything unverified is the literal string
`VERIFY_ON_SITE` in the example JSON, and the connector **refuses to start** while any `VERIFY_ON_SITE` remains.

| Vendor | Table / endpoint | Status |
| --- | --- | --- |
| ZKBioTime / ZKBioSecurity | `iclock_transaction`: `emp_code`, `punch_time`, `verify_type` | Names taken from the integration brief, not checked against vendor docs. Verification codes, DB dialect and a unique `id` column: `VERIFY_ON_SITE` |
| eSSL eTimeTrackLite | `DeviceLogs_*`: `UserId`, `LogDate`, `VerificationMode` | Names taken from the brief. Exact monthly table name and verification codes: `VERIFY_ON_SITE` |
| BioStar 2 (DB) | `t_lg` event log | Table is a belief only. Everything is `VERIFY_ON_SITE`. Prefer the REST source |
| Matrix COSEC CENTRA | event table | Nothing confirmed. Everything is `VERIFY_ON_SITE` |
| BioStar 2 (REST) | `POST /api/login` (`bs-session-id` header), `POST /api/events/search`, `POST/PUT/DELETE /api/users`, `POST /api/doors/open` | Endpoints per Suprema's API reference. Numeric operators, event codes, door id, user create body and JSON field paths: `VERIFY_ON_SITE` (see `https://<biostar-host>/api-docs` on the server) |

## Install

Requires Node 22+ and `pnpm` (or run from a built checkout).

```
pnpm install --frozen-lockfile
cp examples/zkbiotime.json /etc/societyos/edge.json     # pick the closest example, then edit
```

Environment (a `.env` next to the process is also loaded; real env vars win):

```
EDGE_CONFIG=/etc/societyos/edge.json
ZK_DEVICE_TOKEN=sos_...                 # name each variable in the config's *Env fields
ZK_DB_URL=...                           # connection string, see below
```

Secrets are never written in the JSON; the config only holds the *names* of env vars.
The cloud `baseUrl` must be `https` (plain `http` is allowed only for localhost).

Connection strings:

- mssql: `Server=host,1433;Database=ZKBioTime;User Id=societyos_ro;Password=...;Encrypt=true;TrustServerCertificate=true`
- mysql: `mysql://societyos_ro:password@host:3306/dbname`
- postgres: `postgres://societyos_ro:password@host:5432/dbname`

Start: `pnpm --filter @societyos/edge-connector start`. Cursor state is stored in `stateDir` (`<source name>.state.json`),
written atomically. Back that folder up or keep it on persistent disk, deleting it replays from `initialCursor`.

### Linux (systemd)

```
# /etc/systemd/system/societyos-edge.service
[Unit]
Description=SocietyOS edge connector
After=network-online.target

[Service]
User=societyos
WorkingDirectory=/opt/societyos/apps/edge-connector
EnvironmentFile=/etc/societyos/edge.env
ExecStart=/usr/bin/pnpm start
Restart=always
RestartSec=5
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
```

`systemctl enable --now societyos-edge`, logs: `journalctl -u societyos-edge -f`. `chmod 600 /etc/societyos/edge.env`.
SIGTERM finishes the in-flight batch, closes DB pools and exits.

### Windows (NSSM)

Most vendor servers (ZKBioTime, eTimeTrackLite, BioStar 2, COSEC) run on Windows.

```
nssm install SocietyOSEdge "C:\Program Files\nodejs\node.exe" "node_modules\tsx\dist\cli.mjs" src\index.ts
nssm set SocietyOSEdge AppDirectory C:\societyos\apps\edge-connector
nssm set SocietyOSEdge AppEnvironmentExtra EDGE_CONFIG=C:\societyos\edge.json ZK_DEVICE_TOKEN=... ZK_DB_URL=...
nssm set SocietyOSEdge AppStdout C:\societyos\logs\edge.log
nssm set SocietyOSEdge AppStderr C:\societyos\logs\edge.log
nssm set SocietyOSEdge AppRotateFiles 1
nssm set SocietyOSEdge AppStopMethodConsole 30000
nssm start SocietyOSEdge
```

Restrict the folder holding the env values to the service account.

## Read-only database login

The query guard only accepts a single `SELECT` (no comments, no `INTO`, no stacked statements), but the
database login is the real security boundary. Create a login that can only read the one table/view.

```sql
-- SQL Server
CREATE LOGIN societyos_ro WITH PASSWORD = '<strong>';
USE ZKBioTime; CREATE USER societyos_ro FOR LOGIN societyos_ro;
GRANT SELECT ON dbo.iclock_transaction TO societyos_ro;

-- MySQL
CREATE USER 'societyos_ro'@'%' IDENTIFIED BY '<strong>';
GRANT SELECT ON zkbiotime.iclock_transaction TO 'societyos_ro'@'%';

-- PostgreSQL
CREATE ROLE societyos_ro LOGIN PASSWORD '<strong>';
GRANT CONNECT ON DATABASE zkbiotime TO societyos_ro;
GRANT USAGE ON SCHEMA public TO societyos_ro;
GRANT SELECT ON public.iclock_transaction TO societyos_ro;
```

## SQL source configuration

| Field | Meaning |
| --- | --- |
| `dialect` | `mssql`, `mysql` or `postgres` |
| `connectionStringEnv` | env var holding the connection string |
| `query` | One SELECT using `@cursor` and `@limit`, `ORDER BY` the cursor column. mssql: `SELECT TOP (@limit) ... WHERE c > @cursor ORDER BY c`; mysql/postgres: `... WHERE c > @cursor ORDER BY c LIMIT @limit` |
| `cursorColumn`, `cursorType` | column to page by; `number` (default) or `datetime` |
| `initialCursor` | first cursor. Default: `0`, or 24 h ago for `datetime` (the cloud drops punches older than 7 days) |
| `pollIntervalSec`, `batchSize` | default 10 s / 200; batchSize max 500 |
| `timezone` | IANA zone of the vendor clock, applied to timestamps stored without an offset (e.g. `Asia/Kolkata`). `datetime2`/`datetime`/`timestamp` are treated as wall-clock |
| `columns` | `deviceUserId`, `occurredAt`, `method` column names; `matched` is `true` (vendor logs only successful matches) or a 0/1 column; optional `vendorEventId` |
| `methodMap` | vendor code -> `FINGERPRINT`, `FACE`, `CARD`, `PIN`, `PALM`, `IRIS`, `UNKNOWN`; unmapped codes use `defaultMethod` |

Behaviour: after the cloud accepts a batch (every outcome `RECORDED`, `DUPLICATE` or `REJECTED`) the cursor is
saved. `REJECTED` rows are logged with the cloud's reason and are not retried. Any HTTP/DB error leaves the cursor
untouched and retries with exponential backoff (1 s to 60 s, jittered). Rows with an unusable user id or
timestamp are skipped and logged.

Cursor tips: use a unique increasing column (an auto-increment `id`) when the vendor has one. A timestamp cursor
with `>` can skip rows that share the exact same timestamp across a batch boundary. If a full batch shares a
single cursor value the connector stops with a "cursor is stuck" error rather than looping.

### eSSL eTimeTrackLite monthly tables

The log table is split per month, so one query cannot name it. Pick one:

1. Preferred: have the site DBA create a view that unions the current and previous month, and recreate it on the
   1st of each month (SQL Agent job). Point `query` at the view (`vw_SocietyOS_DeviceLogs` in the example).
   Grant `societyos_ro` SELECT on the view only.
2. Edit `query` on the 1st of each month and restart the service. Easy to forget.

Confirm the real monthly table name in the database first (`VERIFY_ON_SITE`).

## BioStar 2 REST source

`type: "biostar2"` logs in with `POST /api/login` and keeps the `bs-session-id` (re-login on 401), polls
`POST /api/events/search` for the configured success and failure event codes, and executes cloud sync
commands: create/update user, delete user, open door (`doorId`).

TLS: BioStar 2 usually has a self-signed certificate. Export the certificate (or its CA) as PEM and set `caFile`.
It is added to the trust store for this connection only; verification is never disabled. Set the `baseUrl` host to
a name/IP that is on the certificate.

Because the operators and event codes could not be confirmed offline, `cursorOperator`, `eventCodeOperator` and
`eventCodes` are mandatory config, check them in the server's `/api-docs`. The cursor operator must mean
"datetime >=": duplicates are absorbed by `vendorEventId` and reported `DUPLICATE`.

## SQL sources and sync commands

The connector never writes to a vendor DB, so every sync command (enrol, remove, open door) is acked
`success=false` with `UNSUPPORTED_FOR_SQL_SOURCE: enrol/remove on the terminal or via vendor software`.
Enrol and remove residents in the vendor software.

## Provision the device in SocietyOS and map residents

1. As society admin, add a device with protocol `GENERIC_WEBHOOK` (any SQL source), `SUPREMA_BIOSTAR2` or
   `MATRIX_COSEC`. Copy the device token shown once into the env var named by `deviceTokenEnv`.
2. Each resident needs a terminal user id (letters, digits, `_`, `-`, max 32 chars). Assign it in SocietyOS
   (biometric identities: pass the id already enrolled on the terminal, e.g. the ZKBioTime `emp_code`, or let SocietyOS
   allocate the next numeric id).
3. Enrol the resident's face/fingerprint on the terminal under that same id in the vendor software.
4. Walk up to the terminal. Within one poll interval the event shows in SocietyOS as authorized, or denied with
   a reason such as an unmapped id.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Exits with `Invalid configuration` | Read every listed line; `VERIFY_ON_SITE` must be replaced, env vars must be set |
| `cloud rejected batch with HTTP 401/403` | Wrong or revoked device token, or wrong protocol on the provisioned device |
| `HTTP 400` repeating | A field fails the cloud DTO (id format, timestamp). Compare a row with the mapping |
| `event rejected by cloud` warnings | The reason is logged; commonly an id not mapped to a resident or a punch older than 7 days |
| Nothing arrives, no errors | Query returns nothing past the cursor: delete the state file, lower `initialCursor`, and check `timezone` |
| Timestamps hours off | `timezone` does not match the vendor server's clock zone |
| `cursor is stuck` | Use a unique cursor column or raise `batchSize` |
| BioStar 2 `login failed` / TLS error | Credentials; `caFile` must be the certificate the server presents; host name must match |
| mssql login/TLS errors | Add `Encrypt=true;TrustServerCertificate=true` only for an internal server you control |

Logs are JSON lines. They never contain names or connection strings, and resident ids appear masked (`1***9`).

## Development

```
pnpm --filter @societyos/edge-connector typecheck
pnpm --filter @societyos/edge-connector test
```

Tests use fake DB and HTTP layers only.
