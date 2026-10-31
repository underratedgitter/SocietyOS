# Operations runbook

On-call procedures for the single-host pilot deployment. Commands assume the
repository root on the host and the production compose file:

```bash
alias sos='docker compose -f docker-compose.prod.yml'
```

Keep `.env.production` and generated broker credentials in the secret manager;
never paste their values into an incident channel.

## First five minutes

1. Confirm the symptom scope: all users, one society, one gate, or one device.
2. Check container health and readiness:

   ```bash
   sos ps
   curl -fsS http://localhost/healthz
   curl -fsS http://localhost/api/v1/readyz | jq
   sos logs --since=15m api web nginx
   ```

3. Read the `components` object in `readyz`:
   - `database: down` → API returns `503`; all writes fail. Go to
     [PostgreSQL unavailable](#postgresql-unavailable).
   - `redis: degraded` → rate limiting is per-process and less strict. Gate
     verification still works.
   - `mqtt: degraded` → guard and kiosk verification still work, but device
     verification returns `CONTROLLER_UNAVAILABLE` and no gate opens.
4. Correlate a failing request by `x-request-id` from the browser response with
   the API log line and the `requestId` in the error envelope.
5. Record the timeline in the incident ticket. Do not restart containers before
   capturing logs if the failure may be data-related.

The API returns errors as `{ code, message, requestId, details? }`. Use `code`
for decisions; `message` is safe to show to users.

## Service is down

```bash
sos ps
sos up -d
sos logs --tail=200 api
```

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `api` restarting, log says `Invalid configuration: ...` | Missing/invalid `.env.production` value | Fix the named variable, `sos up -d api` |
| `api` restarting, `P1001`/`P1000` | PostgreSQL not ready or wrong `DATABASE_URL` | Check `sos logs postgres`; verify credentials |
| `api` restarts after a deploy | Failed migration | Read the migration error; restore the pre-deploy dump if irreversible |
| `nginx` unhealthy | API or web unhealthy | `sos ps`; Nginx depends on both being healthy |
| `web` unhealthy | Build/runtime error or `API_INTERNAL_URL` wrong | `sos logs web`; confirm `http://api:4000` |

Startup is intentionally strict: the API refuses to run in production with
placeholder secrets or an `http://` `WEB_URL`.

## PostgreSQL unavailable

1. Check the container and disk:

   ```bash
   sos ps postgres
   sos logs --tail=100 postgres
   df -h /var/lib/docker
   ```

2. If the volume is full, free space and restart. Do not delete
   `postgres_data`.
3. If the database is corrupted, restore the most recent verified dump:

   ```bash
   CONFIRM_RESTORE=yes sh infrastructure/scripts/restore-postgres.sh backups/societyos-<stamp>.dump
   ```

4. After recovery, run `curl -fsS http://localhost/api/v1/readyz`, sign in, and
   check the access log shows new events. Audit gaps are expected between the
   last backup and the incident; note the window in the ticket.

Data loss boundary: passes, access events, audit logs and sessions created after
the dump are lost. Redis contents are expendable.

## Gate does not open

Work from the outside in:

1. **Did the API authorize the credential?** Guard console → *Entry log* shows
   the decision and `reasonCode`. Denials are expected for expired, revoked,
   exhausted or wrong-gate passes.
2. **Was a command issued?** Guard console → *Gate commands* (or admin *Gates &
   devices*) shows `ISSUED`, `ACKNOWLEDGED`, `EXECUTED`, `FAILED` or `EXPIRED`.
3. **Is the controller online?** Admin *Gates & devices* shows `lastSeenAt` and
   status. A controller disables after missed heartbeats in the UI; the API
   still records it `ACTIVE` until an operator disables it.
4. **Is the broker up?**

   ```bash
   sos ps mosquitto
   sos logs --tail=100 mosquitto
   curl -fsS http://localhost/api/v1/readyz | jq '.components.mqtt'
   ```

5. If the command is `EXPIRED`, the 30-second window passed before delivery. The
   visitor can present the credential again; uses are only consumed at
   authorization, not on a failed delivery. Check the access event before
   assuming a free retry.
6. If commands are `ISSUED` but never acknowledged, check the device firmware,
   its broker credentials and the topic ACL. With the shared device identity,
   confirm the controller uses `societyos-device`.

Never hand-open a gate by publishing an MQTT message. Commands must carry the
per-device HMAC signature and are validated against the command row.

## Broker outage or credential mismatch

The API reconnects every 3 seconds. Mosquitto refuses connections when the
password file or ACL is missing, unreadable or out of sync with
`MQTT_USERNAME`/`MQTT_PASSWORD`.

```bash
sos logs mosquitto | grep -i 'denied\|not authorised\|error'
```

To rotate broker credentials:

1. Generate new passwords and rewrite the files:

   ```bash
   MQTT_API_PASSWORD='new-api' MQTT_DEVICE_PASSWORD='new-device' \
     sh infrastructure/scripts/generate-mqtt-credentials.sh
   ```

2. Update `MQTT_PASSWORD` for the API in `.env.production` (keep
   `MQTT_USERNAME=societyos-api`).
3. Restart the affected services:

   ```bash
   sos up -d --force-recreate mosquitto api
   ```

4. Update every controller with the new device password and re-provision it if
   it also lost its API token.

The bundled broker is plaintext inside the compose network. Devices on an
untrusted network must reach it through a TLS terminator or a certificate-enabled
listener; otherwise an attacker on that network can replay broker credentials.

## Device lost, stolen or suspected compromised

Rotate the API credential and disable the device. Both actions are audited.

- **Admin console** → *Gates & devices* → device row → **Rotate**, then
  **Disable**.
- **API**, if the console is unavailable:

  ```bash
  curl -X POST https://ops.example.com/api/v1/devices/<deviceId>/rotate-credential \
    -H 'Content-Type: application/json' -b cookies.txt
  curl -X POST https://ops.example.com/api/v1/devices/<deviceId>/disable \
    -H 'Content-Type: application/json' -b cookies.txt
  ```

Rotation revokes the previous token and command secret immediately and expires
pending commands. Disabling prevents device authentication and expires pending
commands; re-enabling is an explicit admin action.

After rotating, update the controller before re-enabling. If the controller
cannot be recovered, remove it from service and provision a replacement with a
new `deviceUid`.

Also check the broker ACL if the device used the shared `societyos-device`
identity: a stolen device password is valid for every controller. Rotate the
device broker password and update all remaining controllers, or move to
per-device broker identities (recommended before a wider rollout).

## Visitor credential exposed

1. Identify the pass in the resident or admin console (visitor name, flat,
   window).
2. Revoke it. Residents can revoke their own passes; admins can revoke any pass
   in the society. Revocation is immediate and recorded in the audit log.
3. If the PIN was shared broadly, review access events for that pass and the
   gate for unexpected entries.
4. Never reissue the same PIN. A new pass gets a fresh random credential.

Rate limits (per device, per credential and per guard) and security alerts for
repeated failures are the detection layer. If alerts are missing for an
incident, check that `RATE_LIMIT_ENABLED` is not disabled and that Redis is
reachable.

## Stuck or flapping gate

- Use the guard console *Gate commands* view to see the last command result.
- A command stuck in `ISSUED` past `expiresAt` is marked `EXPIRED` by the
  maintenance sweep within 15 seconds.
- `FAILED` acknowledgements include the device-reported state; inspect
  `gateStateAtExec` and the device health log.
- If the physical barrier is stuck open, dispatch staff and power-cycle the
  controller according to its hardware manual. Do not disable the device while
  the gate is physically open unless staff are present.
- If the controller reports `FAULT`, disable it to stop accepting credentials at
  that gate and route visitors to another access point.

## Redis outage

Redis only backs rate limiting. The API logs a warning and falls back to the
in-process limiter, then reconnects automatically.

- Expect weaker cross-replica limits if you run more than one API instance.
- Do not restart the API just for Redis. Restart Redis when convenient:

  ```bash
  sos restart redis
  ```

- Redis data is disposable; `redis_data` can be recreated if corrupted.

## Restore and disaster recovery

1. Provision the host and check out the same revision.
2. Restore `.env.production` and the Mosquitto `passwd`/`acl` files from the
   secret manager.
3. Start PostgreSQL only, restore the dump, then start the rest:

   ```bash
   sos up -d postgres
   CONFIRM_RESTORE=yes sh infrastructure/scripts/restore-postgres.sh backups/societyos-<stamp>.dump
   sos up -d
   ```

4. Verify `/healthz`, `/api/v1/readyz`, sign-in, one pass issuance and one
   guard verification.
5. Reissue device credentials if `DEVICE_SECRET_ENC_KEY` was lost; stored device
   command secrets cannot be decrypted without it.

Recovery targets for the pilot: RPO 24 hours (nightly dump), RTO 2 hours.

## Routine checks

Daily:

- `sos ps` shows all services healthy.
- `/api/v1/readyz` returns `200` and no component `down`.
- Nightly backup exists and `pg_restore --list` reads it.
- No unresolved `CRITICAL` security alerts in the admin console.

Weekly:

- Rehearse a restore into a scratch database.
- Review audit log for unexpected role changes, device provisioning or
  credential rotation.
- Check disk usage for `postgres_data`, Docker images and backups.

Monthly:

- Rotate broker passwords and the notification webhook secret.
- Review admin and guard accounts; disable leavers.
- Apply host and image security updates in a maintenance window.

## Escalation evidence to capture

- Incident start/end in UTC and affected societies, gates and devices.
- `x-request-id` values for failing requests.
- `sos ps` output and relevant `sos logs --since=...` excerpts.
- `readyz` output, and query results for the affected `AccessEvent`,
  `GateCommand`, `AuditLog` and `SecurityAlert` rows.
- Whether any credential, device token or broker password may have leaked, and
  which rotations were performed.
