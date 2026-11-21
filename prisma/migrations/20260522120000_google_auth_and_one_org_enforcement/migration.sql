-- AlterTable: make password nullable and add Google OAuth fields
ALTER TABLE "User"
  ALTER COLUMN "password" DROP NOT NULL,
  ADD COLUMN "googleId" TEXT,
  ADD COLUMN "phoneNumber" TEXT;

-- CreateIndex: unique constraint on googleId
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
