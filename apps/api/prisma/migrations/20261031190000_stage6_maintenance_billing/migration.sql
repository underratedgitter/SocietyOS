-- Create enums if not exist
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InvoiceStatus') THEN
    CREATE TYPE "InvoiceStatus" AS ENUM ('PENDING', 'PAID', 'OVERDUE', 'CANCELLED');
  END IF;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "maintenance_invoices" (
    "id" UUID NOT NULL,
    "society_id" UUID NOT NULL,
    "flat_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "due_date" TIMESTAMPTZ(6) NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "paid_at" TIMESTAMPTZ(6),
    "paid_by_id" UUID,
    "payment_reference" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "maintenance_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "maintenance_invoices_society_id_status_due_date_idx" ON "maintenance_invoices"("society_id", "status", "due_date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "maintenance_invoices_flat_id_idx" ON "maintenance_invoices"("flat_id");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'maintenance_invoices_society_id_fkey') THEN
    ALTER TABLE "maintenance_invoices" ADD CONSTRAINT "maintenance_invoices_society_id_fkey" FOREIGN KEY ("society_id") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'maintenance_invoices_flat_id_fkey') THEN
    ALTER TABLE "maintenance_invoices" ADD CONSTRAINT "maintenance_invoices_flat_id_fkey" FOREIGN KEY ("flat_id") REFERENCES "Flat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'maintenance_invoices_paid_by_id_fkey') THEN
    ALTER TABLE "maintenance_invoices" ADD CONSTRAINT "maintenance_invoices_paid_by_id_fkey" FOREIGN KEY ("paid_by_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
