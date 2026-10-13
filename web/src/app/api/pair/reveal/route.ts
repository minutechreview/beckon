import { z } from "zod";
import { json, requireUser } from "@/lib/api";
import { UUID_RE } from "@/gateway/protocol";
import { rateLimit } from "@/lib/ratelimit";
import { fromB64url } from "@/lib/crypto/bytes";
import { pairBytes, revealPairRequest } from "@/lib/devices";

const body = z.object({ request_id: z.string().regex(UUID_RE), device_id: z.string().regex(UUID_RE), nonce: pairBytes });

/**
 * The device reveals its pairing nonce (SPEC §8.2), once the host has answered
 * its commitment. Refused unless the nonce opens the commitment over the
 * device's registered keys.
 */
export async function POST(req: Request) {
  const u = await requireUser();
  if ("error" in u) return u.error;
  const limited = await rateLimit("pair-reveal", u.userId, 20, 10 * 60_000);
  if (limited) return limited;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_request" }, 400);
  const out = await revealPairRequest(u.userId, parsed.data.request_id, parsed.data.device_id, fromB64url(parsed.data.nonce));
  return out ? json({ request: out }) : json({ error: "not_found" }, 404);
}
