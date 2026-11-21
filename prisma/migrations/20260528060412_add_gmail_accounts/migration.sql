-- CreateTable
CREATE TABLE "GmailAccount" (
    "id" TEXT NOT NULL,
    "accountEmail" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
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

    CONSTRAINT "GmailAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GmailAccount_organisationId_idx" ON "GmailAccount"("organisationId");

-- CreateIndex
CREATE UNIQUE INDEX "GmailAccount_organisationId_accountEmail_key" ON "GmailAccount"("organisationId", "accountEmail");

-- AddForeignKey
ALTER TABLE "GmailAccount" ADD CONSTRAINT "GmailAccount_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GmailAccount" ADD CONSTRAINT "GmailAccount_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
