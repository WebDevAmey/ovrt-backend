-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('ADMIN', 'USER', 'ANALYST', 'CONNECTOR_ADMIN', 'BILLING_ADMIN', 'AUDITOR');

-- CreateEnum
CREATE TYPE "ConversationState" AS ENUM ('ACTIVE', 'ARCHIVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ConversationPhase" AS ENUM ('NOT_STARTED', 'CLASSIFYING', 'ANSWERING', 'AGENTS_WORKING', 'ANSWERED', 'CANCELLED', 'ERROR');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT', 'TOOL', 'SYSTEM');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "DatasourceStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "DatasourceProvider" AS ENUM ('POSTGRES', 'MYSQL', 'BIGQUERY', 'SNOWFLAKE', 'REDSHIFT', 'GOOGLE_SHEETS', 'EXCEL', 'POWER_BI', 'SALESFORCE', 'ZOHO_CRM', 'HUBSPOT', 'GOOGLE_ADS', 'FACEBOOK_ADS', 'GOOGLE_DRIVE', 'STRIPE');

-- CreateEnum
CREATE TYPE "SchemaSnapshotStatus" AS ENUM ('RUNNING', 'NOT_STARTED', 'ERROR', 'COMPLETED');

-- CreateEnum
CREATE TYPE "OntologyFunctionKind" AS ENUM ('SQL', 'SPREADSHEET', 'STRIPE_API', 'CRM_API', 'ADS_API', 'CUSTOM');

-- CreateEnum
CREATE TYPE "OntologyFunctionSourceType" AS ENUM ('WAREHOUSE', 'DATASHEET', 'CRM', 'ADS', 'BILLING');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "role" "OrgRole" NOT NULL DEFAULT 'USER',
    "allowedAccess" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "restrictedAccess" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "memory" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rateWindowStartedAt" TIMESTAMP(3),
    "rateWindowTokens" INTEGER NOT NULL DEFAULT 0,
    "rateWindowMessages" INTEGER NOT NULL DEFAULT 0,
    "tokenLimitPerWindow" INTEGER NOT NULL DEFAULT 200000,
    "messageLimitPerWindow" INTEGER NOT NULL DEFAULT 50,
    "windowDurationMs" INTEGER NOT NULL DEFAULT 18000000,
    "verificationOTP" TEXT,
    "verificationOTPExpires" TIMESTAMP(3),
    "resetPasswordExpires" TIMESTAMP(3),
    "resetPasswordToken" TEXT,
    "organisationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organisation" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "onboardingComplete" BOOLEAN NOT NULL DEFAULT false,
    "businessContext" JSONB NOT NULL DEFAULT '{}',
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "rateWindowStartedAt" TIMESTAMP(3),
    "rateWindowTokens" INTEGER NOT NULL DEFAULT 0,
    "rateWindowMessages" INTEGER NOT NULL DEFAULT 0,
    "tokenLimitPerWindow" INTEGER NOT NULL DEFAULT 2000000,
    "messageLimitPerWindow" INTEGER NOT NULL DEFAULT 500,
    "windowDurationMs" INTEGER NOT NULL DEFAULT 18000000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organisation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "intent" JSONB NOT NULL DEFAULT '{}',
    "state" "ConversationState" NOT NULL DEFAULT 'ACTIVE',
    "phase" "ConversationPhase" NOT NULL DEFAULT 'NOT_STARTED',
    "result" JSONB NOT NULL DEFAULT '{}',
    "memory" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "organisationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "from" "MessageRole" NOT NULL,
    "content" JSONB NOT NULL,
    "attachments" JSONB NOT NULL,
    "modelName" TEXT,
    "agentStatus" JSONB NOT NULL DEFAULT '[]',
    "conversationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "mediaType" TEXT,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "parentId" TEXT,
    "agentName" TEXT NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'RUNNING',
    "modelProvider" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "costMicros" INTEGER NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserFiles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "aiDescription" TEXT,
    "url" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserFiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgFiles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "aiDescription" TEXT,
    "url" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgFiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Warehouse" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "description" TEXT,
    "aiDescription" TEXT,
    "provider" "DatasourceProvider" NOT NULL,
    "credentialRef" TEXT NOT NULL,
    "status" "DatasourceStatus" NOT NULL,
    "statusDetails" JSONB NOT NULL DEFAULT '{}',
    "lastSyncedAt" TIMESTAMP(3),
    "healthStatus" TEXT NOT NULL,
    "lastHealthCheckAt" TIMESTAMP(3),
    "lastError" TEXT,
    "scopeConfig" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdByUserId" TEXT NOT NULL,
    "host" TEXT,
    "port" INTEGER,
    "database" TEXT,
    "user" TEXT,
    "sslMode" TEXT,
    "projectId" TEXT,
    "bqDataset" TEXT,
    "account" TEXT,
    "warehouse" TEXT,
    "bqSchema" TEXT,
    "role" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataSheet" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "description" TEXT,
    "aiDescription" TEXT,
    "provider" "DatasourceProvider" NOT NULL,
    "credentialRef" TEXT NOT NULL,
    "status" "DatasourceStatus" NOT NULL,
    "statusDetails" JSONB NOT NULL DEFAULT '{}',
    "lastSyncedAt" TIMESTAMP(3),
    "healthStatus" TEXT NOT NULL,
    "lastHealthCheckAt" TIMESTAMP(3),
    "lastError" TEXT,
    "scopeConfig" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdByUserId" TEXT NOT NULL,
    "spreadsheetId" TEXT,
    "fileRef" TEXT,
    "datasetId" TEXT,
    "workspaceId" TEXT,
    "oauthAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataSheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Crm" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "description" TEXT,
    "aiDescription" TEXT,
    "provider" "DatasourceProvider" NOT NULL,
    "credentialRef" TEXT NOT NULL,
    "status" "DatasourceStatus" NOT NULL,
    "statusDetails" JSONB NOT NULL DEFAULT '{}',
    "lastSyncedAt" TIMESTAMP(3),
    "healthStatus" TEXT NOT NULL,
    "lastHealthCheckAt" TIMESTAMP(3),
    "lastError" TEXT,
    "scopeConfig" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdByUserId" TEXT NOT NULL,
    "instanceUrl" TEXT,
    "tenantId" TEXT,
    "oauthAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Crm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ads" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "description" TEXT,
    "aiDescription" TEXT,
    "provider" "DatasourceProvider" NOT NULL,
    "credentialRef" TEXT NOT NULL,
    "status" "DatasourceStatus" NOT NULL,
    "statusDetails" JSONB NOT NULL DEFAULT '{}',
    "lastSyncedAt" TIMESTAMP(3),
    "healthStatus" TEXT NOT NULL,
    "lastHealthCheckAt" TIMESTAMP(3),
    "lastError" TEXT,
    "scopeConfig" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdByUserId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "managerId" TEXT,
    "oauthAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Billing" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "description" TEXT,
    "aiDescription" TEXT,
    "provider" "DatasourceProvider" NOT NULL,
    "credentialRef" TEXT NOT NULL,
    "status" "DatasourceStatus" NOT NULL,
    "statusDetails" JSONB NOT NULL DEFAULT '{}',
    "lastSyncedAt" TIMESTAMP(3),
    "healthStatus" TEXT NOT NULL,
    "lastHealthCheckAt" TIMESTAMP(3),
    "lastError" TEXT,
    "scopeConfig" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdByUserId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL DEFAULT false,
    "country" TEXT,
    "oauthAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Billing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchemaSnapshot" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "lastCheckedAt" TIMESTAMP(3),
    "schemaJson" JSONB NOT NULL,
    "hash" TEXT NOT NULL,
    "status" "SchemaSnapshotStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchemaSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OntologyEntity" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OntologyEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyIntegration" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shopId" BIGINT,
    "shopName" TEXT,
    "shopOwner" TEXT,
    "shopEmail" TEXT,
    "country" TEXT,
    "currency" TEXT,
    "planName" TEXT,
    "primaryDomain" TEXT,
    "timezone" TEXT,
    "myshopifyDomain" TEXT,
    "status" "DatasourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "healthStatus" TEXT NOT NULL DEFAULT 'healthy',
    "lastError" TEXT,
    "lastHealthCheckAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OntologyFunction" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "kind" "OntologyFunctionKind" NOT NULL,
    "sourceType" "OntologyFunctionSourceType",
    "sourceId" TEXT,
    "definition" JSONB NOT NULL,
    "parameters" JSONB NOT NULL DEFAULT '[]',
    "returns" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OntologyFunction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Conversation_userId_createdAt_idx" ON "Conversation"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Conversation_organisationId_createdAt_idx" ON "Conversation"("organisationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Conversation_state_idx" ON "Conversation"("state");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Job_threadId_key" ON "Job"("threadId");

-- CreateIndex
CREATE INDEX "Job_userId_createdAt_idx" ON "Job"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Job_status_idx" ON "Job"("status");

-- CreateIndex
CREATE INDEX "Job_conversationId_idx" ON "Job"("conversationId");

-- CreateIndex
CREATE INDEX "AgentRun_jobId_idx" ON "AgentRun"("jobId");

-- CreateIndex
CREATE INDEX "AgentRun_parentId_idx" ON "AgentRun"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Warehouse_organisationId_provider_name_key" ON "Warehouse"("organisationId", "provider", "name");

-- CreateIndex
CREATE UNIQUE INDEX "DataSheet_organisationId_provider_name_key" ON "DataSheet"("organisationId", "provider", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Crm_organisationId_provider_name_key" ON "Crm"("organisationId", "provider", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Ads_organisationId_provider_name_key" ON "Ads"("organisationId", "provider", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Billing_organisationId_provider_accountId_key" ON "Billing"("organisationId", "provider", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "OntologyEntity_organisationId_name_key" ON "OntologyEntity"("organisationId", "name");

-- CreateIndex
CREATE INDEX "ShopifyIntegration_organisationId_idx" ON "ShopifyIntegration"("organisationId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyIntegration_organisationId_shopDomain_key" ON "ShopifyIntegration"("organisationId", "shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "OntologyFunction_organisationId_name_key" ON "OntologyFunction"("organisationId", "name");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "AgentRun"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "UserFiles" ADD CONSTRAINT "UserFiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgFiles" ADD CONSTRAINT "OrgFiles_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Warehouse" ADD CONSTRAINT "Warehouse_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Warehouse" ADD CONSTRAINT "Warehouse_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataSheet" ADD CONSTRAINT "DataSheet_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataSheet" ADD CONSTRAINT "DataSheet_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Crm" ADD CONSTRAINT "Crm_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Crm" ADD CONSTRAINT "Crm_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ads" ADD CONSTRAINT "Ads_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ads" ADD CONSTRAINT "Ads_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Billing" ADD CONSTRAINT "Billing_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Billing" ADD CONSTRAINT "Billing_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchemaSnapshot" ADD CONSTRAINT "SchemaSnapshot_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OntologyEntity" ADD CONSTRAINT "OntologyEntity_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyIntegration" ADD CONSTRAINT "ShopifyIntegration_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OntologyFunction" ADD CONSTRAINT "OntologyFunction_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
