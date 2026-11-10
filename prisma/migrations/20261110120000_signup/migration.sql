-- AlterEnum
ALTER TYPE "ChallengePurpose" ADD VALUE 'SIGNUP';

-- AlterTable
ALTER TABLE "AuthChallenge" ADD COLUMN     "email" TEXT,
ALTER COLUMN "userId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "AuthChallenge_email_purpose_createdAt_idx" ON "AuthChallenge"("email", "purpose", "createdAt");
