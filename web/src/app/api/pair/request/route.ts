import { z } from "zod";
import { json, requireUser } from "@/lib/api";
import { UUID_RE } from "@/gateway/protocol";
import { assertCanPairDevice, PlanLimitError } from "@/lib/plans";
import { rateLimit } from "@/lib/ratelimit";
import { createPairRequest, pairBytes } from "@/lib/devices";
import { fromB64url } from "@/lib/crypto/bytes";

const body = z.object({ host_id: z.string().regex(UUID_RE), device_id: z.string().regex(UUID_RE), commitment: pairBytes });

/**
 * A device asks a host to trust it (SPEC §8.2), committing to its keys and a
 * nonce it reveals later. The response carries the host's public keys as the
 * server knows them; the device only pins them after the user has compared
 * safety codes with `beckon pair`.
 */
export async function POST(req: Request) {
  const u = await requireUser();
  if ("error" in u) return u.error;
  const limited = await rateLimit("pair-request", u.userId, 20, 10 * 60_000);
  if (limited) return limited;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_request" }, 400);
  try {
    await assertCanPairDevice(u.userId, parsed.data.device_id);
  } catch (err) {
    if (err instanceof PlanLimitError) return json({ error: err.code, message: err.message }, 402);
    throw err;
  }
  const out = await createPairRequest(u.userId, parsed.data.host_id, parsed.data.device_id, fromB64url(parsed.data.commitment));
  return out ? json(out) : json({ error: "not_found" }, 404);
}
