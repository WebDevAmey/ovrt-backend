-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "resourcesUsed" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "OntologyFunction" ADD COLUMN     "questionHash" TEXT;

-- CreateIndex
CREATE INDEX "OntologyFunction_organisationId_sourceId_questionHash_idx" ON "OntologyFunction"("organisationId", "sourceId", "questionHash");
