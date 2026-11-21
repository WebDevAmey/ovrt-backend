-- DropTable (old generic DataSheet)
DROP TABLE IF EXISTS "DataSheet";

-- CreateTable
CREATE TABLE "GoogleSheet" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "spreadsheetId" TEXT NOT NULL,
    "sheetUrl" TEXT NOT NULL,
    "accessTokenRef" TEXT NOT NULL,
    "refreshTokenRef" TEXT NOT NULL,
    "tokenExpiry" TIMESTAMP(3),
    "status" "DatasourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "healthStatus" TEXT NOT NULL DEFAULT 'unknown',
    "lastError" TEXT,
    "lastHealthCheckAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleSheet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GoogleSheet_organisationId_idx" ON "GoogleSheet"("organisationId");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleSheet_organisationId_spreadsheetId_key" ON "GoogleSheet"("organisationId", "spreadsheetId");

-- AddForeignKey
ALTER TABLE "GoogleSheet" ADD CONSTRAINT "GoogleSheet_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleSheet" ADD CONSTRAINT "GoogleSheet_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
