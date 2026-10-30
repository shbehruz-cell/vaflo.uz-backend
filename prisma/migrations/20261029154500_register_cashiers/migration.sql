-- AlterTable
ALTER TABLE "Register" ADD COLUMN     "maxCashiers" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "RegisterAssignment" (
    "registerId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegisterAssignment_pkey" PRIMARY KEY ("registerId","userId")
);

-- CreateIndex
CREATE INDEX "RegisterAssignment_userId_idx" ON "RegisterAssignment"("userId");

-- AddForeignKey
ALTER TABLE "RegisterAssignment" ADD CONSTRAINT "RegisterAssignment_registerId_fkey" FOREIGN KEY ("registerId") REFERENCES "Register"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegisterAssignment" ADD CONSTRAINT "RegisterAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
