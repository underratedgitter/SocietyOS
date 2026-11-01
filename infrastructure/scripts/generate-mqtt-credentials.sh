#!/usr/bin/env sh
set -eu

# Usage:
#   MQTT_API_PASSWORD='...' MQTT_DEVICE_PASSWORD='...' \
#     sh infrastructure/scripts/generate-mqtt-credentials.sh

DEVICE_ID="${DEVICE_ID:-controller-main}"
SOCIETY_ID="${SOCIETY_ID:-demo-society}"
DEVICE_USERNAME="${DEVICE_USERNAME:-device-${DEVICE_ID}}"

if [ "${DRY_RUN:-}" = "true" ] || [ "${DRY_RUN:-}" = "1" ]; then
  DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../docker/mosquitto" && pwd)"
  echo "[DRY-RUN] Target mosquitto directory: $DIR"
  echo "[DRY-RUN] Would generate ACL configuration at $DIR/acl"
  echo "[DRY-RUN] Isolated topic scope: society/$SOCIETY_ID/device/$DEVICE_ID/# for $DEVICE_USERNAME"
  echo "[DRY-RUN] Would run eclipse-mosquitto:2 container to generate hashed password file $DIR/passwd"
  exit 0
fi

: "${MQTT_API_PASSWORD:?Set MQTT_API_PASSWORD}"
: "${MQTT_DEVICE_PASSWORD:?Set MQTT_DEVICE_PASSWORD}"

DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../docker/mosquitto" && pwd)"

mkdir -p "$DIR"

cat > "$DIR/acl" <<ACL
# API service: publishes commands and reads device telemetry/acks.
user societyos-api
topic readwrite society/#
topic read \$SYS/#

# Isolated device identity for controller $DEVICE_ID in society $SOCIETY_ID.
user $DEVICE_USERNAME
topic read society/$SOCIETY_ID/device/$DEVICE_ID/commands
topic readwrite society/$SOCIETY_ID/device/$DEVICE_ID/acknowledgements
topic readwrite society/$SOCIETY_ID/device/$DEVICE_ID/events
topic readwrite society/$SOCIETY_ID/device/$DEVICE_ID/health
topic readwrite society/$SOCIETY_ID/device/$DEVICE_ID/telemetry
topic readwrite society/$SOCIETY_ID/device/$DEVICE_ID/#
ACL

chmod 600 "$DIR/acl"

docker run --rm -i \
  -e API_PASS="$MQTT_API_PASSWORD" \
  -e DEVICE_PASS="$MQTT_DEVICE_PASSWORD" \
  -e DEVICE_USER="$DEVICE_USERNAME" \
  -v "$DIR:/mosquitto/config" \
  eclipse-mosquitto:2 \
  sh -c 'set -e; rm -f /mosquitto/config/passwd; touch /mosquitto/config/passwd; mosquitto_passwd -b /mosquitto/config/passwd societyos-api "$API_PASS"; mosquitto_passwd -b /mosquitto/config/passwd "$DEVICE_USER" "$DEVICE_PASS"; chmod 600 /mosquitto/config/passwd'

echo "Wrote $DIR/passwd and $DIR/acl for $DEVICE_USERNAME. Keep both files private and out of git."
