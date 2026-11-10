-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "deviceName" TEXT,
ADD COLUMN     "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "platform" TEXT;

-- Mavjud sessiyalar uchun birinchi kirish vaqti sifatida yaratilgan vaqt olinadi
UPDATE "Session" SET "firstSeenAt" = "createdAt";
