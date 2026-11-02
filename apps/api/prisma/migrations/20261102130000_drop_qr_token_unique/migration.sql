-- DropIndex
-- Drop partial unique index on QR credentials as Prisma cannot represent partial indexes (WHERE type = 'QR')
-- We rely on 192-bit cryptographically secure random QR tokens and access engine pass.societyId checks
DROP INDEX IF EXISTS "VisitorPassCredential_qr_token_unique";
