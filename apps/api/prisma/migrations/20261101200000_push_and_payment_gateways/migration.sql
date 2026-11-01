-- AlterEnum
ALTER TYPE "NotificationChannel" ADD VALUE IF NOT EXISTS 'WHATSAPP';

-- AlterTable
ALTER TABLE "maintenance_invoices" ADD COLUMN IF NOT EXISTS "gateway_order_id" TEXT;
ALTER TABLE "maintenance_invoices" ADD COLUMN IF NOT EXISTS "gateway_payment_id" TEXT;
ALTER TABLE "maintenance_invoices" ADD COLUMN IF NOT EXISTS "payment_gateway" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "push_device_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'expo',
    "device_name" TEXT,
    "endpoint" TEXT,
    "p256dh" TEXT,
    "auth" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "push_device_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "push_device_tokens_token_key" ON "push_device_tokens"("token");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "push_device_tokens_user_id_idx" ON "push_device_tokens"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "maintenance_invoices_gateway_order_id_idx" ON "maintenance_invoices"("gateway_order_id");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'push_device_tokens_user_id_fkey') THEN
    ALTER TABLE "push_device_tokens" ADD CONSTRAINT "push_device_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
