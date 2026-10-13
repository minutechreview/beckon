import { z } from "zod";
import { db, schema } from "@/db";
import { json } from "@/lib/api";
import { publicKey } from "@/lib/devices";
import { ipLimit } from "@/lib/ratelimit";
import { hashToken, newDeviceCode, newUserCode } from "@/lib/tokens";

const EXPIRES_S = 600;
const INTERVAL_S = 2;

const body = z.object({
  label: z.string().trim().min(1).max(64).optional(),
  // The helper's freshly generated public keys (SPEC §8.1). Private keys never leave the host.
  sign_pubkey: publicKey,
  box_pubkey: publicKey,
});

/** Starts the device-code flow for `beckon login`. Unauthenticated by design. */
export async function POST(req: Request) {
  const limited = await ipLimit(req, "device-code", 20, 10 * 60_000);
  if (limited) return limited;
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return json({ error: "invalid_request" }, 400);

  const deviceCode = newDeviceCode();
  let userCode = "";
  for (let attempt = 0; ; attempt++) {
    userCode = newUserCode();
    try {
      await db().insert(schema.deviceCodes).values({
        deviceCodeHash: hashToken(deviceCode),
        userCode,
        label: parsed.data.label ?? "host",
        signPubkey: Buffer.from(parsed.data.sign_pubkey, "base64url"),
        boxPubkey: Buffer.from(parsed.data.box_pubkey, "base64url"),
        expiresAt: new Date(Date.now() + EXPIRES_S * 1000),
      });
      break;
    } catch (err) {
      if (attempt >= 3) throw err; // user_code collision: pick another
    }
  }

  const base = process.env.AUTH_URL ?? new URL(req.url).origin;
  return json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${base}/device`,
    verification_uri_complete: `${base}/device?code=${userCode}`,
    expires_in: EXPIRES_S,
    interval: INTERVAL_S,
  });
}
