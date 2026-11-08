-- Deduplicate existing duplicate (deviceId, sequence) keeping the earliest row
DELETE FROM "DeviceEvent"
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY "deviceId", "sequence"
      ORDER BY "occurredAt" ASC, "id" ASC
    ) as rnum
    FROM "DeviceEvent"
    WHERE "sequence" IS NOT NULL
  ) t
  WHERE t.rnum > 1
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DeviceEvent_deviceId_sequence_key" ON "DeviceEvent"("deviceId", "sequence");
