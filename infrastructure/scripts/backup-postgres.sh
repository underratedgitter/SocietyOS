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

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

OUTPUT="$BACKUP_DIR/societyos-$STAMP.dump"
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner > "$OUTPUT"
chmod 600 "$OUTPUT"

find "$BACKUP_DIR" -maxdepth 1 -name 'societyos-*.dump' -type f -mtime "+$RETENTION_DAYS" -delete

echo "Backup written: $OUTPUT"
echo "Verify it with: pg_restore --list '$OUTPUT'"
