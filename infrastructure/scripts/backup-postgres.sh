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

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
POSTGRES_USER="${POSTGRES_USER:-societyos}"
POSTGRES_DB="${POSTGRES_DB:-societyos}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUTPUT="$BACKUP_DIR/societyos-$STAMP.dump"

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

find "$BACKUP_DIR" -maxdepth 1 -name 'societyos-*.dump' -type f -mtime "+$RETENTION_DAYS" -delete

echo "Backup written: $OUTPUT"
echo "Verify it with: pg_restore --list '$OUTPUT'"
