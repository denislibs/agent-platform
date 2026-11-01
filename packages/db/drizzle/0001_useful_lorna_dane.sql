DROP INDEX "tasks_status_idx";--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "millicredits" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "millicredits" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "files_user_idx" ON "files" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tasks_status_updated_idx" ON "tasks" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "usage_task_idx" ON "usage_events" USING btree ("task_id");