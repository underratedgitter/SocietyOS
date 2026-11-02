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
if [ "$#" -ne 1 ]; then
  echo "Usage: CONFIRM_RESTORE=yes sh infrastructure/scripts/restore-postgres.sh <dump-file>" >&2
  exit 1
fi
if [ ! -f "$1" ] && [ "${DRY_RUN:-}" != "true" ] && [ "${DRY_RUN:-}" != "1" ]; then
  echo "Dump file not found: $1" >&2
  exit 1
fi

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

POSTGRES_USER="${POSTGRES_USER:-societyos}"
POSTGRES_DB="${POSTGRES_DB:-societyos}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
DUMP="$1"

if [ "${DRY_RUN:-}" = "true" ] || [ "${DRY_RUN:-}" = "1" ]; then
  echo "[DRY-RUN] Target dump file: $DUMP"
  echo "[DRY-RUN] Target database: $POSTGRES_DB as user $POSTGRES_USER"
  echo "[DRY-RUN] Target compose file: $COMPOSE_FILE"
  echo "[DRY-RUN] Would execute: docker compose -f $COMPOSE_FILE stop api web"
  echo "[DRY-RUN] Would execute: pg_restore -U $POSTGRES_USER -d $POSTGRES_DB --clean --if-exists --no-owner < $DUMP"
  echo "[DRY-RUN] Would execute: docker compose -f $COMPOSE_FILE up -d api web"
  exit 0
fi

docker compose -f "$COMPOSE_FILE" stop api web >/dev/null 2>&1 || true
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner < "$DUMP"
docker compose -f "$COMPOSE_FILE" up -d api web

echo "Restore complete. Run the readiness probe and a smoke test before reopening."
