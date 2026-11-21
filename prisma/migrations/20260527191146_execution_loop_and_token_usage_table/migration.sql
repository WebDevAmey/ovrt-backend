-- CreateEnum
CREATE TYPE "PlayCategory" AS ENUM ('MARKETING', 'COMMUNICATION', 'PRICING', 'PRODUCT', 'RETENTION', 'OPERATIONS', 'CUSTOMER_EXPERIENCE', 'INVENTORY', 'OTHER');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'SCHEDULED', 'EXECUTING', 'COMPLETED', 'EXPIRED', 'SUPERSEDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "RecommendationSource" AS ENUM ('ANALYST_JOB', 'AGENT', 'USER', 'RULE', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "ExecutionChannel" AS ENUM ('META_ADS', 'GOOGLE_ADS', 'FACEBOOK_ADS', 'WHATSAPP', 'EMAIL', 'SMS', 'SHOPIFY', 'CRM', 'INTERNAL', 'MANUAL', 'OTHER');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('PENDING', 'SCHEDULED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "ExecutionMode" AS ENUM ('AUTOMATED', 'MANUAL', 'SEMI_AUTOMATED');

-- CreateEnum
CREATE TYPE "OutcomeType" AS ENUM ('ORDER', 'REFUND', 'RETURN', 'RENEWAL', 'CHURN', 'SIGNUP', 'CLICK', 'IMPRESSION', 'CONVERSION', 'ENGAGEMENT', 'UNSUBSCRIBE', 'ADD_TO_CART', 'CHECKOUT_STARTED', 'REVIEW', 'CUSTOM');

-- CreateEnum
CREATE TYPE "AttributionType" AS ENUM ('DIRECT', 'LAST_TOUCH', 'MULTI_TOUCH', 'MODELED', 'HOLDOUT_DIFF', 'ASSUMED');

-- CreateEnum
CREATE TYPE "HoldoutType" AS ENUM ('RANDOM', 'MATCHED', 'GEO', 'TIME_SPLIT', 'NONE');

-- CreateEnum
CREATE TYPE "CustomerIdType" AS ENUM ('SHOPIFY_CUSTOMER_ID', 'WHATSAPP_E164', 'META_USER_ID', 'GOOGLE_USER_ID', 'EMAIL_HASH', 'PHONE_HASH', 'INTERNAL_ID', 'OTHER');

-- CreateEnum
CREATE TYPE "LiftMetric" AS ENUM ('REVENUE', 'ORDERS', 'AOV', 'CONVERSION_RATE', 'RETENTION_RATE', 'CHURN_RATE', 'ENGAGEMENT_RATE', 'RETURN_RATE', 'CLICK_THROUGH_RATE', 'CONTRIBUTION_MARGIN', 'OTHER');

-- CreateEnum
CREATE TYPE "LiftStatus" AS ENUM ('PRELIMINARY', 'FINAL', 'INVALIDATED');

-- CreateEnum
CREATE TYPE "LiftMethodology" AS ENUM ('BAYESIAN', 'FREQUENTIST_T_TEST', 'FREQUENTIST_CHI_SQ', 'DIFF_IN_DIFF', 'SYNTHETIC_CONTROL', 'INTERRUPTED_TIME_SERIES', 'OTHER');

-- CreateEnum
CREATE TYPE "AiServiceProvider" AS ENUM ('ANTHROPIC', 'OPENAI', 'GOOGLE', 'AZURE_OPENAI', 'AWS_BEDROCK', 'COHERE', 'MISTRAL', 'GROQ', 'XAI', 'DEEPSEEK', 'PERPLEXITY', 'OPENROUTER', 'OTHER');

-- CreateEnum
CREATE TYPE "AiCallKind" AS ENUM ('CHAT_COMPLETION', 'EMBEDDING', 'IMAGE', 'AUDIO_TRANSCRIPTION', 'AUDIO_SYNTHESIS', 'RERANK', 'MODERATION', 'OTHER');

-- CreateEnum
CREATE TYPE "AiCallStatus" AS ENUM ('SUCCEEDED', 'FAILED', 'TIMEOUT', 'RATE_LIMITED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Recommendation" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "playCategory" "PlayCategory" NOT NULL,
    "playType" TEXT NOT NULL,
    "playVersion" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "rationale" TEXT,
    "parameters" JSONB NOT NULL DEFAULT '{}',
    "targetSegment" JSONB NOT NULL DEFAULT '{}',
    "estimatedAudienceSize" INTEGER,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "sourceType" "RecommendationSource" NOT NULL,
    "sourceRef" TEXT,
    "sourceAnomalyId" TEXT,
    "generatedByModel" TEXT,
    "generatedByAgent" TEXT,
    "expectedImpact" JSONB NOT NULL DEFAULT '{}',
    "expectedRevenueMinor" BIGINT,
    "expectedRevenueCurrency" TEXT,
    "expectedCostMinor" BIGINT,
    "expectedCostCurrency" TEXT,
    "expectedRoi" DOUBLE PRECISION,
    "confidence" DOUBLE PRECISION,
    "riskLevel" "RiskLevel" NOT NULL DEFAULT 'MEDIUM',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" "RecommendationStatus" NOT NULL DEFAULT 'PROPOSED',
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "parentRecommendationId" TEXT,
    "supersededById" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecommendationExecution" (
    "id" TEXT NOT NULL,
    "recommendationId" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "channel" "ExecutionChannel" NOT NULL,
    "channelIntegrationType" TEXT,
    "channelIntegrationId" TEXT,
    "mode" "ExecutionMode" NOT NULL DEFAULT 'AUTOMATED',
    "status" "ExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "externalRef" TEXT,
    "externalUrl" TEXT,
    "externalStatus" TEXT,
    "idempotencyKey" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "variantKey" TEXT,
    "audienceSnapshot" JSONB NOT NULL DEFAULT '{}',
    "audienceSize" INTEGER,
    "actualCostMinor" BIGINT,
    "actualCostCurrency" TEXT,
    "costBreakdown" JSONB NOT NULL DEFAULT '{}',
    "scheduledFor" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "executedByUserId" TEXT,
    "executedByAgent" TEXT,
    "error" TEXT,
    "errorPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecommendationExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecommendationOutcome" (
    "id" TEXT NOT NULL,
    "executionId" TEXT,
    "recommendationId" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "outcomeType" "OutcomeType" NOT NULL,
    "outcomeSubtype" TEXT,
    "valueMinor" BIGINT,
    "currency" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "customerExternalId" TEXT,
    "customerIdType" "CustomerIdType",
    "customerSegmentTag" TEXT,
    "isHoldout" BOOLEAN NOT NULL DEFAULT false,
    "attributionType" "AttributionType" NOT NULL DEFAULT 'ASSUMED',
    "attributionConfidence" DOUBLE PRECISION,
    "attributionWindowSec" INTEGER,
    "source" TEXT NOT NULL,
    "rawEventRef" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecommendationHoldout" (
    "id" TEXT NOT NULL,
    "recommendationId" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "holdoutType" "HoldoutType" NOT NULL DEFAULT 'RANDOM',
    "segmentDefinition" JSONB NOT NULL DEFAULT '{}',
    "customerExternalIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "customerIdType" "CustomerIdType",
    "holdoutSize" INTEGER NOT NULL DEFAULT 0,
    "treatmentSize" INTEGER NOT NULL DEFAULT 0,
    "assignmentMethod" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecommendationHoldout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiftMeasurement" (
    "id" TEXT NOT NULL,
    "recommendationId" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "metric" "LiftMetric" NOT NULL,
    "metricLabel" TEXT,
    "treatmentMean" DOUBLE PRECISION NOT NULL,
    "treatmentN" INTEGER NOT NULL,
    "holdoutMean" DOUBLE PRECISION NOT NULL,
    "holdoutN" INTEGER NOT NULL,
    "liftAbsolute" DOUBLE PRECISION NOT NULL,
    "liftRelative" DOUBLE PRECISION,
    "incrementalValueMinor" BIGINT,
    "currency" TEXT,
    "methodology" "LiftMethodology" NOT NULL DEFAULT 'FREQUENTIST_T_TEST',
    "methodologyParams" JSONB NOT NULL DEFAULT '{}',
    "pValue" DOUBLE PRECISION,
    "confidenceLevel" DOUBLE PRECISION NOT NULL DEFAULT 0.95,
    "ciLower" DOUBLE PRECISION,
    "ciUpper" DOUBLE PRECISION,
    "isSignificant" BOOLEAN NOT NULL DEFAULT false,
    "power" DOUBLE PRECISION,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "status" "LiftStatus" NOT NULL DEFAULT 'PRELIMINARY',
    "supersededById" TEXT,
    "invalidationReason" TEXT,
    "notes" TEXT,
    "rawComputation" JSONB NOT NULL DEFAULT '{}',
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiftMeasurement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiTokenUsage" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "userId" TEXT,
    "conversationId" TEXT,
    "messageId" TEXT,
    "jobId" TEXT,
    "agentRunId" TEXT,
    "provider" "AiServiceProvider" NOT NULL,
    "serviceName" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "modelVersion" TEXT,
    "callKind" "AiCallKind" NOT NULL DEFAULT 'CHAT_COMPLETION',
    "endpoint" TEXT,
    "feature" TEXT,
    "agentName" TEXT,
    "operation" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheCreationTokens" INTEGER NOT NULL DEFAULT 0,
    "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicros" BIGINT,
    "currency" TEXT,
    "pricingRef" TEXT,
    "status" "AiCallStatus" NOT NULL DEFAULT 'SUCCEEDED',
    "latencyMs" INTEGER,
    "ttftMs" INTEGER,
    "finishReason" TEXT,
    "toolCallCount" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "requestId" TEXT,
    "traceId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiTokenUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Recommendation_organisationId_status_createdAt_idx" ON "Recommendation"("organisationId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Recommendation_organisationId_playCategory_status_idx" ON "Recommendation"("organisationId", "playCategory", "status");

-- CreateIndex
CREATE INDEX "Recommendation_organisationId_playType_idx" ON "Recommendation"("organisationId", "playType");

-- CreateIndex
CREATE INDEX "Recommendation_organisationId_expiresAt_idx" ON "Recommendation"("organisationId", "expiresAt");

-- CreateIndex
CREATE INDEX "Recommendation_sourceAnomalyId_idx" ON "Recommendation"("sourceAnomalyId");

-- CreateIndex
CREATE INDEX "Recommendation_parentRecommendationId_idx" ON "Recommendation"("parentRecommendationId");

-- CreateIndex
CREATE UNIQUE INDEX "RecommendationExecution_idempotencyKey_key" ON "RecommendationExecution"("idempotencyKey");

-- CreateIndex
CREATE INDEX "RecommendationExecution_recommendationId_idx" ON "RecommendationExecution"("recommendationId");

-- CreateIndex
CREATE INDEX "RecommendationExecution_organisationId_status_idx" ON "RecommendationExecution"("organisationId", "status");

-- CreateIndex
CREATE INDEX "RecommendationExecution_channel_status_idx" ON "RecommendationExecution"("channel", "status");

-- CreateIndex
CREATE INDEX "RecommendationExecution_externalRef_idx" ON "RecommendationExecution"("externalRef");

-- CreateIndex
CREATE INDEX "RecommendationExecution_scheduledFor_idx" ON "RecommendationExecution"("scheduledFor");

-- CreateIndex
CREATE INDEX "RecommendationOutcome_recommendationId_occurredAt_idx" ON "RecommendationOutcome"("recommendationId", "occurredAt");

-- CreateIndex
CREATE INDEX "RecommendationOutcome_executionId_idx" ON "RecommendationOutcome"("executionId");

-- CreateIndex
CREATE INDEX "RecommendationOutcome_organisationId_outcomeType_occurredAt_idx" ON "RecommendationOutcome"("organisationId", "outcomeType", "occurredAt");

-- CreateIndex
CREATE INDEX "RecommendationOutcome_customerExternalId_idx" ON "RecommendationOutcome"("customerExternalId");

-- CreateIndex
CREATE UNIQUE INDEX "RecommendationOutcome_source_rawEventRef_key" ON "RecommendationOutcome"("source", "rawEventRef");

-- CreateIndex
CREATE INDEX "RecommendationHoldout_recommendationId_idx" ON "RecommendationHoldout"("recommendationId");

-- CreateIndex
CREATE INDEX "RecommendationHoldout_organisationId_idx" ON "RecommendationHoldout"("organisationId");

-- CreateIndex
CREATE INDEX "LiftMeasurement_recommendationId_computedAt_idx" ON "LiftMeasurement"("recommendationId", "computedAt" DESC);

-- CreateIndex
CREATE INDEX "LiftMeasurement_organisationId_metric_computedAt_idx" ON "LiftMeasurement"("organisationId", "metric", "computedAt" DESC);

-- CreateIndex
CREATE INDEX "LiftMeasurement_status_idx" ON "LiftMeasurement"("status");

-- CreateIndex
CREATE INDEX "AiTokenUsage_organisationId_createdAt_idx" ON "AiTokenUsage"("organisationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AiTokenUsage_organisationId_provider_modelName_createdAt_idx" ON "AiTokenUsage"("organisationId", "provider", "modelName", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AiTokenUsage_organisationId_feature_createdAt_idx" ON "AiTokenUsage"("organisationId", "feature", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AiTokenUsage_userId_createdAt_idx" ON "AiTokenUsage"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AiTokenUsage_conversationId_idx" ON "AiTokenUsage"("conversationId");

-- CreateIndex
CREATE INDEX "AiTokenUsage_messageId_idx" ON "AiTokenUsage"("messageId");

-- CreateIndex
CREATE INDEX "AiTokenUsage_jobId_idx" ON "AiTokenUsage"("jobId");

-- CreateIndex
CREATE INDEX "AiTokenUsage_status_idx" ON "AiTokenUsage"("status");

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_sourceAnomalyId_fkey" FOREIGN KEY ("sourceAnomalyId") REFERENCES "InsightAnomaly"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_parentRecommendationId_fkey" FOREIGN KEY ("parentRecommendationId") REFERENCES "Recommendation"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "RecommendationExecution" ADD CONSTRAINT "RecommendationExecution_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationExecution" ADD CONSTRAINT "RecommendationExecution_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationExecution" ADD CONSTRAINT "RecommendationExecution_executedByUserId_fkey" FOREIGN KEY ("executedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationOutcome" ADD CONSTRAINT "RecommendationOutcome_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "RecommendationExecution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationOutcome" ADD CONSTRAINT "RecommendationOutcome_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationOutcome" ADD CONSTRAINT "RecommendationOutcome_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationHoldout" ADD CONSTRAINT "RecommendationHoldout_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationHoldout" ADD CONSTRAINT "RecommendationHoldout_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiftMeasurement" ADD CONSTRAINT "LiftMeasurement_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiftMeasurement" ADD CONSTRAINT "LiftMeasurement_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiTokenUsage" ADD CONSTRAINT "AiTokenUsage_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiTokenUsage" ADD CONSTRAINT "AiTokenUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiTokenUsage" ADD CONSTRAINT "AiTokenUsage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiTokenUsage" ADD CONSTRAINT "AiTokenUsage_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiTokenUsage" ADD CONSTRAINT "AiTokenUsage_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
