ALTER TABLE "schedules" DROP CONSTRAINT "schedules_run_type";--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_run_type" CHECK ("schedules"."run_type" in ('pulse', 'check'));