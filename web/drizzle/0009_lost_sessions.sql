ALTER TABLE "sessions" ADD COLUMN "seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "lost" boolean DEFAULT false NOT NULL;