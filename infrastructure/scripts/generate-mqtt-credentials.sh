#!/usr/bin/env sh
set -eu

# Usage:
#   MQTT_API_PASSWORD='...' MQTT_DEVICE_PASSWORD='...' \
#     sh infrastructure/scripts/generate-mqtt-credentials.sh

: "${MQTT_API_PASSWORD:?Set MQTT_API_PASSWORD}"
: "${MQTT_DEVICE_PASSWORD:?Set MQTT_DEVICE_PASSWORD}"

DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../docker/mosquitto" && pwd)"
mkdir -p "$DIR"

cat > "$DIR/acl" <<'ACL'
# API service: publishes commands and reads device telemetry/acks.
user societyos-api
topic readwrite society/#
topic read $SYS/#

# Shared device identity for the pilot. Replace with one broker identity per
# controller before a wider hardware rollout (see docs/RUNBOOK.md).
user societyos-device
topic read society/+/device/+/commands
topic readwrite society/+/device/+/acknowledgements
topic readwrite society/+/device/+/events
topic readwrite society/+/device/+/health
topic readwrite society/+/device/+/telemetry
ACL

chmod 600 "$DIR/acl"

docker run --rm -i \
  -e API_PASS="$MQTT_API_PASSWORD" \
  -e DEVICE_PASS="$MQTT_DEVICE_PASSWORD" \
  -v "$DIR:/mosquitto/config" \
  eclipse-mosquitto:2 \
  sh -c 'set -e; rm -f /mosquitto/config/passwd; touch /mosquitto/config/passwd; mosquitto_passwd -b /mosquitto/config/passwd societyos-api "$API_PASS"; mosquitto_passwd -b /mosquitto/config/passwd societyos-device "$DEVICE_PASS"; chmod 600 /mosquitto/config/passwd'

echo "Wrote $DIR/passwd and $DIR/acl. Keep both files private and out of git."
