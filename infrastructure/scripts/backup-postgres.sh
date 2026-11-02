#!/usr/bin/env sh
set -eu

# Usage:
#   sh infrastructure/scripts/backup-postgres.sh
#   BACKUP_DIR=/secure/backups RETENTION_DAYS=30 sh infrastructure/scripts/backup-postgres.sh
#
# The dump is written to the host filesystem; encrypt or upload it with your
# normal backup tooling. Test restores regularly.

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$ROOT"

# Load database configuration from environment file if not explicitly set
ENV_FILE="${ENV_FILE:-.env.production}"
if [ ! -f "$ENV_FILE" ] && [ -f ".env" ]; then
  ENV_FILE=".env"
fi

if [ -f "$ENV_FILE" ]; then
  if [ -z "${POSTGRES_USER:-}" ]; then
    VAL="$(grep -E '^POSTGRES_USER=' "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '\r"' || true)"
    [ -n "$VAL" ] && POSTGRES_USER="$VAL"
  fi
  if [ -z "${POSTGRES_DB:-}" ]; then
    VAL="$(grep -E '^POSTGRES_DB=' "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '\r"' || true)"
    [ -n "$VAL" ] && POSTGRES_DB="$VAL"
  fi
  if [ -z "${POSTGRES_DB:-}" ] || [ -z "${POSTGRES_USER:-}" ]; then
    DB_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '\r"' || true)"
    if [ -n "$DB_URL" ]; then
      PARSED_USER="$(echo "$DB_URL" | sed -nE 's#^[a-zA-Z0-9]+://([^:]+):.*#\1#p' || true)"
      PARSED_DB="$(echo "$DB_URL" | sed -nE 's#^[a-zA-Z0-9]+://[^/]+/([^?]+).*#\1#p' || true)"
      [ -z "${POSTGRES_USER:-}" ] && [ -n "$PARSED_USER" ] && POSTGRES_USER="$PARSED_USER"
      [ -z "${POSTGRES_DB:-}" ] && [ -n "$PARSED_DB" ] && POSTGRES_DB="$PARSED_DB"
    fi
  fi
fi

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
POSTGRES_USER="${POSTGRES_USER:-societyos}"
POSTGRES_DB="${POSTGRES_DB:-societyos}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUTPUT="$BACKUP_DIR/$POSTGRES_DB-$STAMP.dump"

if [ "${DRY_RUN:-}" = "true" ] || [ "${DRY_RUN:-}" = "1" ]; then
  echo "[DRY-RUN] Target backup directory: $BACKUP_DIR"
  echo "[DRY-RUN] Target compose file: $COMPOSE_FILE"
  echo "[DRY-RUN] Target database: $POSTGRES_DB as user $POSTGRES_USER"
  echo "[DRY-RUN] Output file: $OUTPUT"
  echo "[DRY-RUN] Retention cleanup: older than $RETENTION_DAYS days"
  exit 0
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner > "$OUTPUT"
chmod 600 "$OUTPUT"

find "$BACKUP_DIR" -maxdepth 1 \( -name "$POSTGRES_DB-*.dump" -o -name 'societyos-*.dump' \) -type f -mtime "+$RETENTION_DAYS" -delete

echo "Backup written: $OUTPUT"
echo "Verify it with: pg_restore --list '$OUTPUT'"
