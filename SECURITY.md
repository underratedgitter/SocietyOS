# Security policy

SocietyOS controls physical gate access, so security reports are taken
seriously even in the pilot phase. This file explains how to report a
vulnerability and what the current deployment does and does not protect
against.

## Reporting a vulnerability

Please **do not open a public issue** for a suspected vulnerability.

Use GitHub's private vulnerability reporting on this repository
(**Security** → **Report a vulnerability**). If that is unavailable, contact
the maintainer through the private channel used to deliver this repository and
include the details below.

Include:

- affected component (API, web, device protocol, container or broker config)
  and the version or commit;
- a description of the impact and the attack preconditions;
- reproduction steps or a minimal proof of concept;
- any relevant request IDs, logs or configuration (redact secrets);
- whether the issue is already being exploited.

Do not test against a production deployment, other societies' data, or
physical gate hardware without written authorization. Use a local or preview
stack with seeded demo data.

We aim to acknowledge a report within two business days, provide an initial
assessment within five business days, and coordinate disclosure after a fix is
available. Please give us a reasonable window before publishing details.

## Supported versions

The project is pre-1.0 and ships from `main`. Security fixes are applied to the
latest commit and the current pilot deployment; older revisions are not
maintained. There are no long-term support branches yet.

## Security model

| Control | Implementation |
| --- | --- |
| Password storage | bcrypt cost 12; timing-equalized login for unknown emails |
| Session handling | HTTP-only, `SameSite=Strict`, `Secure` cookies; refresh tokens hashed and rotated on every use |
| Access tokens | HS256 JWT with issuer/audience checks and a 15-minute TTL; user state reloaded per request |
| CSRF | Cookie-authenticated mutations require an allowed `Origin`; CORS is allowlisted |
| Tenant isolation | Society/flat guards plus service-level filters on every lookup; cross-tenant IDs fail closed |
| Credential storage | Keyed HMAC-SHA256 of PIN and QR values; plaintext returned once and never logged |
| Redemption | Conditional `UPDATE` inside a transaction, so concurrent attempts cannot double-spend a pass |
| Device authentication | Random bearer token stored as SHA-256; revocable credential rows |
| Device commands | HMAC-SHA256 signature, per-device secret encrypted with AES-256-GCM, nonce, 30-second expiry, gate/device scope checks |
| Broker access | Password authentication plus per-topic ACL; no anonymous access |
| Abuse resistance | Per-IP, per-account, per-device and per-credential rate limits; brute-force security alerts |
| Input handling | Global whitelist validation, 100 KB JSON limit, strict error envelope without internals |
| Browser hardening | CSP, frame denial, `nosniff`, strict referrer policy, permissions policy |
| Audit | Append-only-by-convention `AuditLog` and `AccessEvent` rows for admin actions and every access decision |
| Secrets at startup | Production refuses placeholder JWT/HMAC secrets and non-HTTPS `WEB_URL` |

Detailed flows are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); deployment
hardening is in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Known limitations

These are accepted constraints of the single-host pilot, not hidden behavior.
Treat them as risks to close before a public or multi-society rollout.

- **No MFA or SSO.** A stolen password is sufficient to sign in. Use strong
  unique passwords, restrict admin accounts and rotate credentials after staff
  changes.
- **Single API instance.** Background maintenance and notification draining are
  in-process. Running multiple replicas requires a queue and distributed locks;
  rate limits also become per-process unless `REDIS_URL` is set.
- **MQTT is plaintext inside the compose network.** It must not be exposed
  directly. Controllers on an untrusted network need a TLS listener or a TLS
  terminator; otherwise broker credentials and traffic can be intercepted.
- **One shared device broker identity** (`societyos-device`) is used by the
  bundled configuration. A stolen device broker password works for every
  controller. Move to per-device broker identities before a wider rollout.
- **The six-digit PIN has a one-million-value space.** Verification is rate
  limited per credential and per actor and emits alerts, but PINs are
  intentionally short for usability. Prefer QR for higher-assurance sites.
- **Demo seed data is not production data.** Never run `db:seed` in production;
  it creates known passwords and visitor PINs. The API does not run it
  automatically.
- **Audit rows are not database-immutable.** They are append-only by
  application convention and protected by database access, not by triggers or
  WORM storage. An operator with direct database access could alter them.
- **No email/SMS delivery in the bundled stack.** Notifications are persisted
  and optionally sent to a webhook; without a provider they remain queued.
  Webhook payloads are HMAC-signed but the endpoint is operator-supplied.
- **No WAF, DDoS protection or bot management.** Put the stack behind a
  provider or ingress that supplies them.
- **No automatic secret rotation.** JWT, HMAC, device encryption and broker
  secrets must be rotated deliberately. Rotating `CREDENTIAL_HMAC_KEY` without
  a migration invalidates existing PIN/QR hashes; rotating
  `DEVICE_SECRET_ENC_KEY` without re-encryption makes device command secrets
  unreadable.
- **No biometrics.** Face/fingerprint entry is explicitly out of scope for this
  release.
- **Localization/time zones** are handled per society, but the pilot has not
  been assessed for privacy regimes beyond the documented data model.

## Deployment hardening checklist

- [ ] `NODE_ENV=production`, `WEB_URL` is HTTPS, `COOKIE_SECURE=true`.
- [ ] Unique 32+ character `JWT_ACCESS_SECRET` and `CREDENTIAL_HMAC_KEY`;
      explicit 32-byte base64 `DEVICE_SECRET_ENC_KEY`.
- [ ] `.env.production` mode `600`, outside git, backed up in a secret manager.
- [ ] Generated Mosquitto `passwd` and `acl` files mounted read-only; broker
      port not published to the host.
- [ ] TLS terminated in front of Nginx; only port 80/443 exposed.
- [ ] PostgreSQL and Redis not published; strong database password; disk
      encryption at the host level.
- [ ] Nightly encrypted backups with tested restores.
- [ ] `ENABLE_SWAGGER=false`; demo seed never run.
- [ ] Admin accounts limited, leavers disabled, `mustChangePassword` honored.
- [ ] Device credentials rotated on loss or suspected compromise; unused
      devices disabled.
- [ ] `/api/v1/readyz` monitored; API logs shipped off-host and retained.
- [ ] Host and image security updates applied; dependency audit reviewed.

## Secret rotation

| Secret | Effect of rotation |
| --- | --- |
| `JWT_ACCESS_SECRET` | All access tokens become invalid; refresh still works and issues new ones |
| `CREDENTIAL_HMAC_KEY` / `_KEY_ID` | Existing PIN/QR hashes stop matching; plan a rehash or reissue window |
| `DEVICE_SECRET_ENC_KEY` | Stored device command secrets cannot be decrypted; re-provision or rotate devices |
| Device bearer token / command secret | Rotate per device in **Gates & devices**; pending commands expire immediately |
| MQTT API password | Update `.env.production` and recreate `mosquitto` and `api` |
| MQTT device password | Update every controller; prefer per-device identities |
| `NOTIFICATION_WEBHOOK_SECRET` | Update the receiver and API together; signatures change |

Never paste secret values into issues, chat, logs or commit messages. If a
secret may have leaked, rotate it first and investigate second.
