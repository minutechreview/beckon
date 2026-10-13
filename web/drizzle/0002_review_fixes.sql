-- Drop duplicates the new unique indexes would reject: the newest pending
-- request per (host, device), the first signed revocation per device.
DELETE FROM "pair_requests" a USING "pair_requests" b
  WHERE a.status = 'pending' AND b.status = 'pending' AND a.host_id = b.host_id AND a.device_id = b.device_id AND a.id < b.id;--> statement-breakpoint
DELETE FROM "device_revocations" a USING "device_revocations" b
  WHERE a.device_id = b.device_id AND a.id > b.id;--> statement-breakpoint
CREATE UNIQUE INDEX "device_revocations_device_uq" ON "device_revocations" USING btree ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pair_requests_pending_uq" ON "pair_requests" USING btree ("host_id","device_id") WHERE status = 'pending';