import os from "node:os";
import path from "node:path";

// Overridable so two checkouts can run the suite at once (each needs its own port and database).
export const E2E_PORT = Number(process.env.BECKON_E2E_PORT ?? 3200);
export const E2E_DB_NAME = process.env.BECKON_E2E_DB_NAME ?? "beckon_e2e";
export const E2E_DB = `postgres://beckon:beckon@localhost:5432/${E2E_DB_NAME}`;
/** Everything the e2e server prints, so E5 can grep it. */
export const SERVER_LOG = path.join(os.tmpdir(), `${E2E_DB_NAME}-server.log`);

/** Test-only VAPID keys (never use these anywhere real): the e2e server signs pushes with them. */
export const E2E_VAPID = {
  publicKey: "BPdJo9eZqVg2bYOn6hrLMaK66giArpC0V4r5llMvVhPuMnIU6E-2zdxRpekvoez6pCI4P3OFpRW9sDAIE4bXf98",
  privateKey: "RYrn7ULkmXZImBPu3FlLf2zj7tgOst_dy7uKIypNZM4",
};
