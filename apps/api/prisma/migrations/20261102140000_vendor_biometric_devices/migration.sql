-- CreateEnum
CREATE TYPE "DeviceProtocol" AS ENUM ('NATIVE', 'GENERIC_WEBHOOK', 'ZKTECO_ADMS', 'HIKVISION_ISAPI', 'DAHUA_HTTP', 'SUPREMA_BIOSTAR2', 'MATRIX_COSEC');

-- CreateEnum
CREATE TYPE "DeviceSyncCommandKind" AS ENUM ('UPSERT_USER', 'DELETE_USER', 'OPEN_DOOR');

-- CreateEnum
CREATE TYPE "DeviceSyncCommandStatus" AS ENUM ('PENDING', 'SENT', 'ACKED', 'FAILED');

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "protocol" "DeviceProtocol" NOT NULL DEFAULT 'NATIVE',
ADD COLUMN     "pushAllowedIps" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "BiometricIdentity" (
    "id" UUID NOT NULL,
    "societyId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(6),

    CONSTRAINT "BiometricIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BiometricEventReceipt" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "accessEventId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BiometricEventReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceSyncCommand" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "kind" "DeviceSyncCommandKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "DeviceSyncCommandStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "result" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),

    CONSTRAINT "DeviceSyncCommand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BiometricIdentity_societyId_deviceUserId_key" ON "BiometricIdentity"("societyId", "deviceUserId");

-- CreateIndex
CREATE UNIQUE INDEX "BiometricIdentity_societyId_userId_key" ON "BiometricIdentity"("societyId", "userId");

-- CreateIndex
CREATE INDEX "BiometricEventReceipt_createdAt_idx" ON "BiometricEventReceipt"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BiometricEventReceipt_deviceId_dedupeKey_key" ON "BiometricEventReceipt"("deviceId", "dedupeKey");

-- CreateIndex
CREATE INDEX "DeviceSyncCommand_deviceId_status_createdAt_idx" ON "DeviceSyncCommand"("deviceId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "BiometricIdentity" ADD CONSTRAINT "BiometricIdentity_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BiometricIdentity" ADD CONSTRAINT "BiometricIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BiometricEventReceipt" ADD CONSTRAINT "BiometricEventReceipt_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceSyncCommand" ADD CONSTRAINT "DeviceSyncCommand_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

