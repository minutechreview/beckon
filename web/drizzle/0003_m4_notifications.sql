CREATE TABLE "client_presence" (
	"conn_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_prefs" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"quiet_start" time,
	"quiet_end" time,
	"notify_blocked" boolean DEFAULT true NOT NULL,
	"notify_error" boolean DEFAULT true NOT NULL,
	"notify_done_min_seconds" integer DEFAULT 60 NOT NULL,
	"per_app" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"path" text NOT NULL,
	"revision" bigint NOT NULL,
	"state" text NOT NULL,
	"kind" text,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"summarized_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "client_presence" ADD CONSTRAINT "client_presence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_presence_user_idx" ON "client_presence" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_transition_uq" ON "notifications" USING btree ("session_id","path","revision");--> statement-breakpoint
CREATE INDEX "notifications_user_sent_idx" ON "notifications" USING btree ("user_id","created_at") WHERE outcome = 'sent';--> statement-breakpoint
CREATE INDEX "notifications_path_sent_idx" ON "notifications" USING btree ("session_id","path","created_at") WHERE outcome = 'sent';--> statement-breakpoint
CREATE INDEX "notifications_collapsed_idx" ON "notifications" USING btree ("user_id","created_at") WHERE outcome = 'collapsed' and summarized_at is null;