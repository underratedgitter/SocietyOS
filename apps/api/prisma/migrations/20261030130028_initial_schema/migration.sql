-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('PLATFORM_ADMIN', 'SOCIETY_ADMIN', 'RESIDENT', 'GUARD');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'INVITED', 'DISABLED');

-- CreateEnum
CREATE TYPE "FlatRelationship" AS ENUM ('OWNER', 'TENANT', 'FAMILY');

-- CreateEnum
CREATE TYPE "VisitorCategory" AS ENUM ('RELATIVE', 'FRIEND', 'DELIVERY', 'CAB', 'MAINTENANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "PassStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'REVOKED', 'EXPIRED', 'EXHAUSTED');

-- CreateEnum
CREATE TYPE "CredentialType" AS ENUM ('PIN', 'QR');

-- CreateEnum
CREATE TYPE "AccessPointType" AS ENUM ('BOOM_BARRIER', 'SLIDING_GATE', 'DOOR_LOCK');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('ACTIVE', 'DISABLED', 'REVOKED');

-- CreateEnum
CREATE TYPE "CommandStatus" AS ENUM ('ISSUED', 'ACKNOWLEDGED', 'EXECUTED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "GateState" AS ENUM ('CLOSED', 'OPENING', 'OPEN', 'CLOSING', 'STOPPED', 'FAULT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "GateCommandType" AS ENUM ('OPEN', 'CLOSE', 'STOP');

-- CreateEnum
CREATE TYPE "AccessDecision" AS ENUM ('AUTHORIZED', 'DENIED');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DeviceEventType" AS ENUM ('COMMAND_RECEIVED', 'ACK', 'STATE_CHANGED', 'SENSOR', 'HEARTBEAT', 'TAMPER', 'FAULT');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('PUSH', 'SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Society" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Society_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocietyMembership" (
    "id" UUID NOT NULL,
    "societyId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "MembershipRole" NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocietyMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Building" (
    "id" UUID NOT NULL,
    "societyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Building_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Flat" (
    "id" UUID NOT NULL,
    "buildingId" UUID NOT NULL,
    "flatNumber" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Flat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResidentFlatMembership" (
    "id" UUID NOT NULL,
    "flatId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "relationship" "FlatRelationship" NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResidentFlatMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Visitor" (
    "id" UUID NOT NULL,
    "societyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "category" "VisitorCategory" NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Visitor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisitorPass" (
    "id" UUID NOT NULL,
    "societyId" UUID NOT NULL,
    "flatId" UUID NOT NULL,
    "hostUserId" UUID NOT NULL,
    "visitorId" UUID NOT NULL,
    "status" "PassStatus" NOT NULL DEFAULT 'DRAFT',
    "category" "VisitorCategory" NOT NULL,
    "validFrom" TIMESTAMPTZ(6) NOT NULL,
    "validUntil" TIMESTAMPTZ(6) NOT NULL,
    "maxUses" INTEGER NOT NULL DEFAULT 1,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" TIMESTAMPTZ(6),
    "revokedBy" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisitorPass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisitorPassCredential" (
    "id" UUID NOT NULL,
    "passId" UUID NOT NULL,
    "type" "CredentialType" NOT NULL,
    "credentialHash" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisitorPassCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisitorPassAccessPoint" (
    "id" UUID NOT NULL,
    "passId" UUID NOT NULL,
    "accessPointId" UUID NOT NULL,

    CONSTRAINT "VisitorPassAccessPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisitorApproval" (
    "id" UUID NOT NULL,
    "passId" UUID NOT NULL,
    "decidedById" UUID,
    "decision" "ApprovalDecision" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisitorApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisitorPassUse" (
    "id" UUID NOT NULL,
    "passId" UUID NOT NULL,
    "redemptionId" TEXT NOT NULL,
    "deviceId" UUID,
    "accessPointId" UUID NOT NULL,
    "usedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisitorPassUse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessPoint" (
    "id" UUID NOT NULL,
    "societyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccessPointType" NOT NULL,
    "location" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" UUID NOT NULL,
    "societyId" UUID NOT NULL,
    "deviceUid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "DeviceStatus" NOT NULL DEFAULT 'ACTIVE',
    "firmware" TEXT,
    "lastSeenAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceCredential" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(6),

    CONSTRAINT "DeviceCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceAccessPoint" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "accessPointId" UUID NOT NULL,

    CONSTRAINT "DeviceAccessPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GateCommand" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "accessPointId" UUID NOT NULL,
    "type" "GateCommandType" NOT NULL,
    "nonce" TEXT NOT NULL,
    "status" "CommandStatus" NOT NULL DEFAULT 'ISSUED',
    "issuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "ackAt" TIMESTAMPTZ(6),
    "executedAt" TIMESTAMPTZ(6),
    "gateStateAtExec" "GateState",

    CONSTRAINT "GateCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceEvent" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "accessPointId" UUID,
    "type" "DeviceEventType" NOT NULL,
    "sequence" INTEGER,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessEvent" (
    "id" UUID NOT NULL,
    "societyId" UUID NOT NULL,
    "accessPointId" UUID,
    "deviceId" UUID,
    "passId" UUID,
    "decision" "AccessDecision" NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "credentialType" "CredentialType",
    "source" TEXT NOT NULL DEFAULT 'DEVICE',
    "requestId" TEXT,
    "meta" JSONB,
    "requestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "societyId" UUID,
    "actorUserId" UUID,
    "actorRole" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityAlert" (
    "id" UUID NOT NULL,
    "societyId" UUID,
    "severity" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(6),

    CONSTRAINT "SecurityAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceHealthLog" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "online" BOOLEAN NOT NULL,
    "uptimeS" INTEGER,
    "rssi" INTEGER,
    "meta" JSONB,
    "recordedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceHealthLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "societyId" UUID,
    "userId" UUID,
    "channel" "NotificationChannel" NOT NULL,
    "template" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMPTZ(6),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshTokenHash_key" ON "Session"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Society_slug_key" ON "Society"("slug");

-- CreateIndex
CREATE INDEX "SocietyMembership_userId_idx" ON "SocietyMembership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SocietyMembership_societyId_userId_key" ON "SocietyMembership"("societyId", "userId");

-- CreateIndex
CREATE INDEX "Building_societyId_idx" ON "Building"("societyId");

-- CreateIndex
CREATE UNIQUE INDEX "Flat_buildingId_flatNumber_key" ON "Flat"("buildingId", "flatNumber");

-- CreateIndex
CREATE INDEX "ResidentFlatMembership_userId_idx" ON "ResidentFlatMembership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ResidentFlatMembership_flatId_userId_key" ON "ResidentFlatMembership"("flatId", "userId");

-- CreateIndex
CREATE INDEX "Visitor_societyId_idx" ON "Visitor"("societyId");

-- CreateIndex
CREATE INDEX "VisitorPass_societyId_status_idx" ON "VisitorPass"("societyId", "status");

-- CreateIndex
CREATE INDEX "VisitorPass_flatId_idx" ON "VisitorPass"("flatId");

-- CreateIndex
CREATE UNIQUE INDEX "VisitorPassCredential_credentialHash_key" ON "VisitorPassCredential"("credentialHash");

-- CreateIndex
CREATE UNIQUE INDEX "VisitorPassCredential_passId_type_key" ON "VisitorPassCredential"("passId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "VisitorPassAccessPoint_passId_accessPointId_key" ON "VisitorPassAccessPoint"("passId", "accessPointId");

-- CreateIndex
CREATE UNIQUE INDEX "VisitorPassUse_redemptionId_key" ON "VisitorPassUse"("redemptionId");

-- CreateIndex
CREATE INDEX "VisitorPassUse_passId_idx" ON "VisitorPassUse"("passId");

-- CreateIndex
CREATE INDEX "AccessPoint_societyId_idx" ON "AccessPoint"("societyId");

-- CreateIndex
CREATE UNIQUE INDEX "Device_deviceUid_key" ON "Device"("deviceUid");

-- CreateIndex
CREATE INDEX "Device_societyId_idx" ON "Device"("societyId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceCredential_tokenHash_key" ON "DeviceCredential"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceAccessPoint_deviceId_accessPointId_key" ON "DeviceAccessPoint"("deviceId", "accessPointId");

-- CreateIndex
CREATE INDEX "GateCommand_deviceId_issuedAt_idx" ON "GateCommand"("deviceId", "issuedAt");

-- CreateIndex
CREATE INDEX "DeviceEvent_deviceId_occurredAt_idx" ON "DeviceEvent"("deviceId", "occurredAt");

-- CreateIndex
CREATE INDEX "AccessEvent_societyId_requestedAt_idx" ON "AccessEvent"("societyId", "requestedAt");

-- CreateIndex
CREATE INDEX "AccessEvent_accessPointId_requestedAt_idx" ON "AccessEvent"("accessPointId", "requestedAt");

-- CreateIndex
CREATE INDEX "AuditLog_societyId_createdAt_idx" ON "AuditLog"("societyId", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityAlert_societyId_createdAt_idx" ON "SecurityAlert"("societyId", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceHealthLog_deviceId_recordedAt_idx" ON "DeviceHealthLog"("deviceId", "recordedAt");

-- CreateIndex
CREATE INDEX "Notification_status_createdAt_idx" ON "Notification"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_key_key" ON "IdempotencyRecord"("key");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocietyMembership" ADD CONSTRAINT "SocietyMembership_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocietyMembership" ADD CONSTRAINT "SocietyMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Building" ADD CONSTRAINT "Building_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flat" ADD CONSTRAINT "Flat_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "Building"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResidentFlatMembership" ADD CONSTRAINT "ResidentFlatMembership_flatId_fkey" FOREIGN KEY ("flatId") REFERENCES "Flat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResidentFlatMembership" ADD CONSTRAINT "ResidentFlatMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visitor" ADD CONSTRAINT "Visitor_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitorPass" ADD CONSTRAINT "VisitorPass_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitorPass" ADD CONSTRAINT "VisitorPass_flatId_fkey" FOREIGN KEY ("flatId") REFERENCES "Flat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitorPass" ADD CONSTRAINT "VisitorPass_visitorId_fkey" FOREIGN KEY ("visitorId") REFERENCES "Visitor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitorPassCredential" ADD CONSTRAINT "VisitorPassCredential_passId_fkey" FOREIGN KEY ("passId") REFERENCES "VisitorPass"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitorPassAccessPoint" ADD CONSTRAINT "VisitorPassAccessPoint_passId_fkey" FOREIGN KEY ("passId") REFERENCES "VisitorPass"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitorPassAccessPoint" ADD CONSTRAINT "VisitorPassAccessPoint_accessPointId_fkey" FOREIGN KEY ("accessPointId") REFERENCES "AccessPoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitorApproval" ADD CONSTRAINT "VisitorApproval_passId_fkey" FOREIGN KEY ("passId") REFERENCES "VisitorPass"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitorPassUse" ADD CONSTRAINT "VisitorPassUse_passId_fkey" FOREIGN KEY ("passId") REFERENCES "VisitorPass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessPoint" ADD CONSTRAINT "AccessPoint_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceCredential" ADD CONSTRAINT "DeviceCredential_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceAccessPoint" ADD CONSTRAINT "DeviceAccessPoint_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceAccessPoint" ADD CONSTRAINT "DeviceAccessPoint_accessPointId_fkey" FOREIGN KEY ("accessPointId") REFERENCES "AccessPoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GateCommand" ADD CONSTRAINT "GateCommand_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GateCommand" ADD CONSTRAINT "GateCommand_accessPointId_fkey" FOREIGN KEY ("accessPointId") REFERENCES "AccessPoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceEvent" ADD CONSTRAINT "DeviceEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessEvent" ADD CONSTRAINT "AccessEvent_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessEvent" ADD CONSTRAINT "AccessEvent_accessPointId_fkey" FOREIGN KEY ("accessPointId") REFERENCES "AccessPoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessEvent" ADD CONSTRAINT "AccessEvent_passId_fkey" FOREIGN KEY ("passId") REFERENCES "VisitorPass"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceHealthLog" ADD CONSTRAINT "DeviceHealthLog_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
