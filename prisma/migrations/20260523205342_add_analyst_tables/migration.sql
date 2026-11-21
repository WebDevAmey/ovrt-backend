-- CreateEnum
CREATE TYPE "AnalystJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "InsightHookStatus" AS ENUM ('PENDING', 'SHOWN', 'ENGAGED', 'DISMISSED');

-- CreateTable
CREATE TABLE "AnalystJob" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "insightType" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "status" "AnalystJobStatus" NOT NULL DEFAULT 'QUEUED',
    "factData" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalystJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InsightAnomaly" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "anomalyDetails" JSONB NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InsightAnomaly_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InsightHook" (
    "id" TEXT NOT NULL,
    "anomalyId" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "insightType" TEXT NOT NULL,
    "hookMessage" TEXT NOT NULL,
    "status" "InsightHookStatus" NOT NULL DEFAULT 'PENDING',
    "conversationId" TEXT,
    "shownAt" TIMESTAMP(3),
    "engagedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InsightHook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnalystJob_organisationId_insightType_createdAt_idx" ON "AnalystJob"("organisationId", "insightType", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "InsightAnomaly_jobId_idx" ON "InsightAnomaly"("jobId");

-- CreateIndex
CREATE INDEX "InsightHook_organisationId_insightType_status_idx" ON "InsightHook"("organisationId", "insightType", "status");

-- AddForeignKey
ALTER TABLE "AnalystJob" ADD CONSTRAINT "AnalystJob_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsightAnomaly" ADD CONSTRAINT "InsightAnomaly_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AnalystJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsightHook" ADD CONSTRAINT "InsightHook_anomalyId_fkey" FOREIGN KEY ("anomalyId") REFERENCES "InsightAnomaly"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsightHook" ADD CONSTRAINT "InsightHook_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
