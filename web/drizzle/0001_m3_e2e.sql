-- M3: end-to-end encryption. M2 data is wiped rather than backfilled: its hosts
-- have no keys (they must re-run `beckon login`) and its enc_* columns hold
-- the removed v0 plaintext envelope. Sessions, records and events cascade.
TRUNCATE "hosts", "device_codes" CASCADE;--> statement-breakpoint
CREATE TABLE "device_revocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"sign_pubkey" "bytea" NOT NULL,
	"by_device_id" uuid NOT NULL,
	"issued_at" text NOT NULL,
	"signature" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sign_pubkey" "bytea" NOT NULL,
	"box_pubkey" "bytea" NOT NULL,
	"push_subscription" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "devices_sign_pubkey_len" CHECK (octet_length("devices"."sign_pubkey") = 32),
	CONSTRAINT "devices_box_pubkey_len" CHECK (octet_length("devices"."box_pubkey") = 32)
);
--> statement-breakpoint
CREATE TABLE "pair_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"host_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "pair_requests_status_chk" CHECK ("pair_requests"."status" in ('pending','confirmed'))
);
--> statement-breakpoint
ALTER TABLE "hosts" ALTER COLUMN "sign_pubkey" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "hosts" ALTER COLUMN "box_pubkey" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "device_codes" ADD COLUMN "sign_pubkey" "bytea" NOT NULL;--> statement-breakpoint
ALTER TABLE "device_codes" ADD COLUMN "box_pubkey" "bytea" NOT NULL;--> statement-breakpoint
ALTER TABLE "device_revocations" ADD CONSTRAINT "device_revocations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_revocations" ADD CONSTRAINT "device_revocations_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_revocations" ADD CONSTRAINT "device_revocations_by_device_id_devices_id_fk" FOREIGN KEY ("by_device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_requests" ADD CONSTRAINT "pair_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_requests" ADD CONSTRAINT "pair_requests_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_requests" ADD CONSTRAINT "pair_requests_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_revocations_user_idx" ON "device_revocations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "devices_user_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_sign_pubkey_uq" ON "devices" USING btree ("sign_pubkey");--> statement-breakpoint
CREATE INDEX "pair_requests_host_idx" ON "pair_requests" USING btree ("host_id");--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "pid";--> statement-breakpoint
ALTER TABLE "device_codes" ADD CONSTRAINT "device_codes_sign_pubkey_len" CHECK (octet_length("device_codes"."sign_pubkey") = 32);--> statement-breakpoint
ALTER TABLE "device_codes" ADD CONSTRAINT "device_codes_box_pubkey_len" CHECK (octet_length("device_codes"."box_pubkey") = 32);--> statement-breakpoint
ALTER TABLE "hosts" ADD CONSTRAINT "hosts_sign_pubkey_len" CHECK (octet_length("hosts"."sign_pubkey") = 32);--> statement-breakpoint
ALTER TABLE "hosts" ADD CONSTRAINT "hosts_box_pubkey_len" CHECK (octet_length("hosts"."box_pubkey") = 32);