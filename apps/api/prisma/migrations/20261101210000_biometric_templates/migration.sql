-- CreateTable
CREATE TABLE IF NOT EXISTS "biometric_templates" (
    "id" UUID NOT NULL,
    "society_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "template_hash" TEXT NOT NULL,
    "encrypted_template" TEXT,
    "algorithm" TEXT NOT NULL,
    "consent_given_at" TIMESTAMPTZ(6) NOT NULL,
    "lawful_basis" TEXT NOT NULL DEFAULT 'DPDP_2023_SECTION_6_EXPLICIT_CONSENT',
    "consent_text" TEXT,
    "enrolled_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "biometric_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "biometric_templates_template_hash_key" ON "biometric_templates"("template_hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "biometric_templates_society_id_user_id_idx" ON "biometric_templates"("society_id", "user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "biometric_templates_template_hash_idx" ON "biometric_templates"("template_hash");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'biometric_templates_society_id_fkey') THEN
    ALTER TABLE "biometric_templates" ADD CONSTRAINT "biometric_templates_society_id_fkey" FOREIGN KEY ("society_id") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'biometric_templates_user_id_fkey') THEN
    ALTER TABLE "biometric_templates" ADD CONSTRAINT "biometric_templates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
