DROP INDEX "job_runs_job_name_started_at_idx";--> statement-breakpoint
CREATE INDEX "job_runs_job_name_finished_at_idx" ON "job_runs" USING btree ("job_name","finished_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "job_runs_ok_job_name_finished_at_idx" ON "job_runs" USING btree ("job_name","finished_at" DESC NULLS FIRST) WHERE "job_runs"."status" = 'ok';