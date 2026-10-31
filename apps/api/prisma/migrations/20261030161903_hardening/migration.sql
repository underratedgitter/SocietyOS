-- DropIndex
DROP INDEX "Notification_status_createdAt_idx";

-- AlterTable
ALTER TABLE "DeviceCredential" ADD COLUMN     "commandSecretEnc" TEXT;

-- AlterTable
ALTER TABLE "GateCommand" ADD COLUMN     "signedPayload" JSONB;

-- AlterTable
ALTER TABLE "IdempotencyRecord" ADD COLUMN     "expiresAt" TIMESTAMPTZ(6),
ADD COLUMN     "requestHash" TEXT;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "nextAttemptAt" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "ResidentFlatMembership" ADD COLUMN     "endedAt" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "Society" ADD COLUMN     "settings" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "GateCommand_status_expiresAt_idx" ON "GateCommand"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE INDEX "Notification_status_nextAttemptAt_createdAt_idx" ON "Notification"("status", "nextAttemptAt", "createdAt");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
