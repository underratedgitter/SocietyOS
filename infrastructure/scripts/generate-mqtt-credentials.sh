#!/usr/bin/env sh
set -eu

# Usage:
#   MQTT_API_PASSWORD='...' MQTT_DEVICE_PASSWORD='...' \
#     sh infrastructure/scripts/generate-mqtt-credentials.sh
#
# Both files end up owned by the broker's mosquitto user (uid 1883) with mode
# 600: the broker drops root and must still read them (e.g. on SIGHUP), and
# mosquitto 2.x warns or refuses when they are owned by someone else.

DEVICE_ID="${DEVICE_ID:-controller-main}"
SOCIETY_ID="${SOCIETY_ID:-demo-society}"
DEVICE_USERNAME="${DEVICE_USERNAME:-device-${DEVICE_ID}}"

if [ "${DRY_RUN:-}" = "true" ] || [ "${DRY_RUN:-}" = "1" ]; then
  DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../docker/mosquitto" && pwd)"
  echo "[DRY-RUN] Target mosquitto directory: $DIR"
  echo "[DRY-RUN] Would generate ACL configuration at $DIR/acl"
  echo "[DRY-RUN] Isolated topic scope: society/$SOCIETY_ID/device/$DEVICE_ID/# for $DEVICE_USERNAME"
  echo "[DRY-RUN] Would run eclipse-mosquitto:2.1.2-alpine container to generate hashed password file $DIR/passwd"
  exit 0
fi

: "${MQTT_API_PASSWORD:?Set MQTT_API_PASSWORD}"
: "${MQTT_DEVICE_PASSWORD:?Set MQTT_DEVICE_PASSWORD}"

DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../docker/mosquitto" && pwd)"

mkdir -p "$DIR"

# A previous run left acl owned by the broker user; replace, don't rewrite.
rm -f "$DIR/acl"
cat > "$DIR/acl" <<ACL
# API service: publishes commands and reads device telemetry/acks.
user societyos-api
topic readwrite society/#
topic read \$SYS/#

# Isolated device identity for controller $DEVICE_ID in society $SOCIETY_ID.
# Least privilege: subscribe to its own commands, publish only its reports.
# No catch-all: device/<id>/# would let it publish onto its own command topic.
user $DEVICE_USERNAME
topic read society/$SOCIETY_ID/device/$DEVICE_ID/commands
topic write society/$SOCIETY_ID/device/$DEVICE_ID/acknowledgements
topic write society/$SOCIETY_ID/device/$DEVICE_ID/events
topic write society/$SOCIETY_ID/device/$DEVICE_ID/health
topic write society/$SOCIETY_ID/device/$DEVICE_ID/telemetry
ACL

chmod 600 "$DIR/acl"

docker run --rm -i \
  -e API_PASS="$MQTT_API_PASSWORD" \
  -e DEVICE_PASS="$MQTT_DEVICE_PASSWORD" \
  -e DEVICE_USER="$DEVICE_USERNAME" \
  -v "$DIR:/mosquitto/config" \
  eclipse-mosquitto:2.1.2-alpine \
  sh -c 'set -e; rm -f /mosquitto/config/passwd; touch /mosquitto/config/passwd; mosquitto_passwd -b /mosquitto/config/passwd societyos-api "$API_PASS"; mosquitto_passwd -b /mosquitto/config/passwd "$DEVICE_USER" "$DEVICE_PASS"; chown mosquitto:mosquitto /mosquitto/config/passwd /mosquitto/config/acl; chmod 600 /mosquitto/config/passwd /mosquitto/config/acl'

echo "Wrote $DIR/passwd and $DIR/acl for $DEVICE_USERNAME. Keep both files private and out of git."
