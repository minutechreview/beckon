CREATE TABLE "responses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"path" text NOT NULL,
	"record_revision" bigint NOT NULL,
	"device_id" uuid NOT NULL,
	"enc_payload" "bytea" NOT NULL,
	"signature" "bytea" NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "responses_status_chk" CHECK (status in ('pending','delivered','applied','rejected_stale','rejected_sig','rejected_replay','rejected_option','rejected_disabled','expired')),
	CONSTRAINT "responses_signature_len" CHECK (octet_length("responses"."signature") = 64)
);
--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "responses_session_idx" ON "responses" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "responses_device_idx" ON "responses" USING btree ("device_id","created_at");--> statement-breakpoint
CREATE INDEX "responses_open_idx" ON "responses" USING btree ("created_at") WHERE status in ('pending','delivered');