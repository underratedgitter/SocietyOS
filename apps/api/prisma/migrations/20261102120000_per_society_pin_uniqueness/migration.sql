-- AlterTable
ALTER TABLE "VisitorPassCredential" ADD COLUMN IF NOT EXISTS "societyId" UUID;

-- Backfill societyId from VisitorPass
UPDATE "VisitorPassCredential" c
SET "societyId" = p."societyId"
FROM "VisitorPass" p
WHERE c."passId" = p."id" AND c."societyId" IS NULL;

-- DropIndex
DROP INDEX IF EXISTS "VisitorPassCredential_credentialHash_key";

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "VisitorPassCredential_societyId_credentialHash_key" ON "VisitorPassCredential"("societyId", "credentialHash");

-- CreateIndex for globally unique QR tokens
CREATE UNIQUE INDEX IF NOT EXISTS "VisitorPassCredential_qr_token_unique" ON "VisitorPassCredential"("credentialHash") WHERE "type" = 'QR';

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'VisitorPassCredential_societyId_fkey'
  ) THEN
    ALTER TABLE "VisitorPassCredential" ADD CONSTRAINT "VisitorPassCredential_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
