-- Create enums if not exist
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AnnouncementCategory') THEN
    CREATE TYPE "AnnouncementCategory" AS ENUM ('GENERAL', 'EMERGENCY', 'MAINTENANCE', 'EVENT');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TicketCategory') THEN
    CREATE TYPE "TicketCategory" AS ENUM ('PLUMBING', 'ELECTRICAL', 'LIFT', 'COMMON_AREA', 'CARPENTRY');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TicketPriority') THEN
    CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TicketStatus') THEN
    CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BookingStatus') THEN
    CREATE TYPE "BookingStatus" AS ENUM ('CONFIRMED', 'CANCELLED');
  END IF;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "announcements" (
    "id" UUID NOT NULL,
    "society_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "category" "AnnouncementCategory" NOT NULL DEFAULT 'GENERAL',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "author_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "maintenance_tickets" (
    "id" UUID NOT NULL,
    "society_id" UUID NOT NULL,
    "flat_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "category" "TicketCategory" NOT NULL,
    "priority" "TicketPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "assigned_staff" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "maintenance_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "amenity_bookings" (
    "id" UUID NOT NULL,
    "society_id" UUID NOT NULL,
    "amenity_name" TEXT NOT NULL,
    "flat_id" UUID NOT NULL,
    "booked_by_id" UUID NOT NULL,
    "slot_start" TIMESTAMPTZ(6) NOT NULL,
    "slot_end" TIMESTAMPTZ(6) NOT NULL,
    "guest_count" INTEGER NOT NULL DEFAULT 1,
    "status" "BookingStatus" NOT NULL DEFAULT 'CONFIRMED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "amenity_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "announcements_society_id_pinned_created_at_idx" ON "announcements"("society_id", "pinned", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "maintenance_tickets_society_id_status_created_at_idx" ON "maintenance_tickets"("society_id", "status", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "maintenance_tickets_flat_id_idx" ON "maintenance_tickets"("flat_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "amenity_bookings_society_id_amenity_name_slot_start_idx" ON "amenity_bookings"("society_id", "amenity_name", "slot_start");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "amenity_bookings_flat_id_idx" ON "amenity_bookings"("flat_id");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'announcements_society_id_fkey') THEN
    ALTER TABLE "announcements" ADD CONSTRAINT "announcements_society_id_fkey" FOREIGN KEY ("society_id") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'announcements_author_id_fkey') THEN
    ALTER TABLE "announcements" ADD CONSTRAINT "announcements_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'maintenance_tickets_society_id_fkey') THEN
    ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_society_id_fkey" FOREIGN KEY ("society_id") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'maintenance_tickets_flat_id_fkey') THEN
    ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_flat_id_fkey" FOREIGN KEY ("flat_id") REFERENCES "Flat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'maintenance_tickets_created_by_id_fkey') THEN
    ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'amenity_bookings_society_id_fkey') THEN
    ALTER TABLE "amenity_bookings" ADD CONSTRAINT "amenity_bookings_society_id_fkey" FOREIGN KEY ("society_id") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'amenity_bookings_flat_id_fkey') THEN
    ALTER TABLE "amenity_bookings" ADD CONSTRAINT "amenity_bookings_flat_id_fkey" FOREIGN KEY ("flat_id") REFERENCES "Flat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'amenity_bookings_booked_by_id_fkey') THEN
    ALTER TABLE "amenity_bookings" ADD CONSTRAINT "amenity_bookings_booked_by_id_fkey" FOREIGN KEY ("booked_by_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
