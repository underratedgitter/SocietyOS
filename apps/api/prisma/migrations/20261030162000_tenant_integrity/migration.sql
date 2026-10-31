-- Defense in depth: the API enforces tenancy, and PostgreSQL rejects rows whose
-- denormalized society_id disagrees with any parent aggregate.

CREATE OR REPLACE FUNCTION societyos_check_visitor_pass_tenant() RETURNS trigger AS $$
DECLARE
  flat_society uuid;
  visitor_society uuid;
BEGIN
  SELECT b."societyId" INTO flat_society
  FROM "Flat" f JOIN "Building" b ON b.id = f."buildingId"
  WHERE f.id = NEW."flatId";
  IF flat_society IS DISTINCT FROM NEW."societyId" THEN
    RAISE EXCEPTION 'TENANT_INTEGRITY_VIOLATION: pass flat belongs to another society';
  END IF;

  SELECT "societyId" INTO visitor_society FROM "Visitor" WHERE id = NEW."visitorId";
  IF visitor_society IS DISTINCT FROM NEW."societyId" THEN
    RAISE EXCEPTION 'TENANT_INTEGRITY_VIOLATION: pass visitor belongs to another society';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER visitor_pass_tenant_guard
BEFORE INSERT OR UPDATE ON "VisitorPass"
FOR EACH ROW EXECUTE FUNCTION societyos_check_visitor_pass_tenant();

CREATE OR REPLACE FUNCTION societyos_check_pass_access_point() RETURNS trigger AS $$
DECLARE
  pass_society uuid;
  ap_society uuid;
BEGIN
  SELECT "societyId" INTO pass_society FROM "VisitorPass" WHERE id = NEW."passId";
  SELECT "societyId" INTO ap_society FROM "AccessPoint" WHERE id = NEW."accessPointId";
  IF pass_society IS DISTINCT FROM ap_society THEN
    RAISE EXCEPTION 'TENANT_INTEGRITY_VIOLATION: pass and access point belong to different societies';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER visitor_pass_access_point_tenant_guard
BEFORE INSERT OR UPDATE ON "VisitorPassAccessPoint"
FOR EACH ROW EXECUTE FUNCTION societyos_check_pass_access_point();

CREATE OR REPLACE FUNCTION societyos_check_device_access_point() RETURNS trigger AS $$
DECLARE
  device_society uuid;
  ap_society uuid;
BEGIN
  SELECT "societyId" INTO device_society FROM "Device" WHERE id = NEW."deviceId";
  SELECT "societyId" INTO ap_society FROM "AccessPoint" WHERE id = NEW."accessPointId";
  IF device_society IS DISTINCT FROM ap_society THEN
    RAISE EXCEPTION 'TENANT_INTEGRITY_VIOLATION: device and access point belong to different societies';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER device_access_point_tenant_guard
BEFORE INSERT OR UPDATE ON "DeviceAccessPoint"
FOR EACH ROW EXECUTE FUNCTION societyos_check_device_access_point();

CREATE OR REPLACE FUNCTION societyos_check_gate_command() RETURNS trigger AS $$
DECLARE
  device_society uuid;
  ap_society uuid;
BEGIN
  SELECT "societyId" INTO device_society FROM "Device" WHERE id = NEW."deviceId";
  SELECT "societyId" INTO ap_society FROM "AccessPoint" WHERE id = NEW."accessPointId";
  IF device_society IS DISTINCT FROM ap_society THEN
    RAISE EXCEPTION 'TENANT_INTEGRITY_VIOLATION: gate command crosses societies';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "DeviceAccessPoint"
    WHERE "deviceId" = NEW."deviceId" AND "accessPointId" = NEW."accessPointId"
  ) THEN
    RAISE EXCEPTION 'COMMAND_SCOPE_VIOLATION: device is not assigned to this access point';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gate_command_tenant_guard
BEFORE INSERT OR UPDATE ON "GateCommand"
FOR EACH ROW EXECUTE FUNCTION societyos_check_gate_command();

CREATE OR REPLACE FUNCTION societyos_check_access_event() RETURNS trigger AS $$
DECLARE
  parent_society uuid;
BEGIN
  IF NEW."accessPointId" IS NOT NULL THEN
    SELECT "societyId" INTO parent_society FROM "AccessPoint" WHERE id = NEW."accessPointId";
    IF parent_society IS DISTINCT FROM NEW."societyId" THEN
      RAISE EXCEPTION 'TENANT_INTEGRITY_VIOLATION: access event access point crosses societies';
    END IF;
  END IF;
  IF NEW."passId" IS NOT NULL THEN
    SELECT "societyId" INTO parent_society FROM "VisitorPass" WHERE id = NEW."passId";
    IF parent_society IS DISTINCT FROM NEW."societyId" THEN
      RAISE EXCEPTION 'TENANT_INTEGRITY_VIOLATION: access event pass crosses societies';
    END IF;
  END IF;
  IF NEW."deviceId" IS NOT NULL THEN
    SELECT "societyId" INTO parent_society FROM "Device" WHERE id = NEW."deviceId";
    IF parent_society IS DISTINCT FROM NEW."societyId" THEN
      RAISE EXCEPTION 'TENANT_INTEGRITY_VIOLATION: access event device crosses societies';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER access_event_tenant_guard
BEFORE INSERT OR UPDATE ON "AccessEvent"
FOR EACH ROW EXECUTE FUNCTION societyos_check_access_event();

CREATE OR REPLACE FUNCTION societyos_check_pass_use() RETURNS trigger AS $$
DECLARE
  pass_society uuid;
  ap_society uuid;
BEGIN
  SELECT "societyId" INTO pass_society FROM "VisitorPass" WHERE id = NEW."passId";
  SELECT "societyId" INTO ap_society FROM "AccessPoint" WHERE id = NEW."accessPointId";
  IF pass_society IS DISTINCT FROM ap_society THEN
    RAISE EXCEPTION 'TENANT_INTEGRITY_VIOLATION: pass use crosses societies';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "VisitorPassAccessPoint"
    WHERE "passId" = NEW."passId" AND "accessPointId" = NEW."accessPointId"
  ) THEN
    RAISE EXCEPTION 'PASS_SCOPE_VIOLATION: access point is not authorized for this pass';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER visitor_pass_use_tenant_guard
BEFORE INSERT OR UPDATE ON "VisitorPassUse"
FOR EACH ROW EXECUTE FUNCTION societyos_check_pass_use();

CREATE OR REPLACE FUNCTION societyos_check_device_event() RETURNS trigger AS $$
BEGIN
  IF NEW."accessPointId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "DeviceAccessPoint"
    WHERE "deviceId" = NEW."deviceId" AND "accessPointId" = NEW."accessPointId"
  ) THEN
    RAISE EXCEPTION 'DEVICE_SCOPE_VIOLATION: event access point is not assigned to this device';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER device_event_scope_guard
BEFORE INSERT OR UPDATE ON "DeviceEvent"
FOR EACH ROW EXECUTE FUNCTION societyos_check_device_event();

-- Evidence tables cannot be altered through the application role.
CREATE OR REPLACE FUNCTION societyos_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY_TABLE: % rows cannot be updated or deleted', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_append_only
BEFORE UPDATE OR DELETE ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION societyos_reject_mutation();

CREATE TRIGGER access_event_append_only
BEFORE UPDATE OR DELETE ON "AccessEvent"
FOR EACH ROW EXECUTE FUNCTION societyos_reject_mutation();

CREATE TRIGGER device_event_append_only
BEFORE UPDATE OR DELETE ON "DeviceEvent"
FOR EACH ROW EXECUTE FUNCTION societyos_reject_mutation();

ALTER TABLE "VisitorPass" ADD CONSTRAINT "visitor_pass_valid_window"
  CHECK ("validUntil" > "validFrom");
ALTER TABLE "VisitorPass" ADD CONSTRAINT "visitor_pass_use_bounds"
  CHECK ("maxUses" BETWEEN 1 AND 100 AND "usedCount" >= 0 AND "usedCount" <= "maxUses");
ALTER TABLE "Notification" ADD CONSTRAINT "notification_attempts_nonnegative"
  CHECK ("attempts" >= 0);
