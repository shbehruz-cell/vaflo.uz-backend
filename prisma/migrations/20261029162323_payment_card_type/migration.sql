-- CreateEnum
CREATE TYPE "CardType" AS ENUM ('UZCARD', 'HUMO', 'VISA', 'MASTERCARD', 'UNIONPAY', 'OTHER');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "cardType" "CardType";
