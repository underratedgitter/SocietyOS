-- Relative-pass and seeded credentials were created with a NULL societyId, which the
-- (societyId, credentialHash) unique index ignores, so same-society PIN collisions went
-- undetected. Backfill from the owning pass. Where a hash already exists in that society, or
-- several NULL rows share one (pre-existing collisions), only the earliest row is backfilled and
-- the rest stay NULL rather than failing the migration.
WITH candidates AS (
  SELECT c.id,
         p."societyId",
         ROW_NUMBER() OVER (
           PARTITION BY p."societyId", c."credentialHash"
           ORDER BY c."createdAt", c.id
         ) AS rn
  FROM "VisitorPassCredential" c
  JOIN "VisitorPass" p ON p.id = c."passId"
  WHERE c."societyId" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "VisitorPassCredential" o
      WHERE o."societyId" = p."societyId" AND o."credentialHash" = c."credentialHash"
    )
)
UPDATE "VisitorPassCredential" c
SET "societyId" = candidates."societyId"
FROM candidates
WHERE c.id = candidates.id AND candidates.rn = 1;
