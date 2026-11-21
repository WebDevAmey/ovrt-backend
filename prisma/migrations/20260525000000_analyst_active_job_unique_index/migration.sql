-- Prevent duplicate active jobs for the same org+insightType.
-- A partial unique index only covers rows where the job is still in-flight
-- (QUEUED or RUNNING), so completed history is unaffected.
-- This is the DB-level guard against the TOCTOU race in trigger.ts.
CREATE UNIQUE INDEX "AnalystJob_active_unique"
  ON "AnalystJob"("organisationId", "insightType")
  WHERE status IN ('QUEUED', 'RUNNING');
