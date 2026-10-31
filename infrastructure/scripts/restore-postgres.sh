#!/usr/bin/env sh
set -eu

# Usage:
#   CONFIRM_RESTORE=yes sh infrastructure/scripts/restore-postgres.sh backups/societyos-....dump
#
# DESTRUCTIVE: drops and recreates objects in the target database. Stop the API
# first and take a fresh backup before restoring.

if [ "${CONFIRM_RESTORE:-}" != "yes" ]; then
  echo "Refusing to restore without CONFIRM_RESTORE=yes" >&2
  exit 1
fi
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "Usage: CONFIRM_RESTORE=yes sh infrastructure/scripts/restore-postgres.sh <dump-file>" >&2
  exit 1
fi

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$ROOT"

POSTGRES_USER="${POSTGRES_USER:-societyos}"
POSTGRES_DB="${POSTGRES_DB:-societyos}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
DUMP="$1"

docker compose -f "$COMPOSE_FILE" stop api web >/dev/null 2>&1 || true
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner < "$DUMP"
docker compose -f "$COMPOSE_FILE" up -d api web

echo "Restore complete. Run the readiness probe and a smoke test before reopening."
