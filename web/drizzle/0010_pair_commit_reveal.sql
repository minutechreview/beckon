ALTER TABLE "pair_requests" ADD COLUMN "commitment" "bytea";--> statement-breakpoint
ALTER TABLE "pair_requests" ADD COLUMN "host_nonce" "bytea";--> statement-breakpoint
ALTER TABLE "pair_requests" ADD COLUMN "device_nonce" "bytea";