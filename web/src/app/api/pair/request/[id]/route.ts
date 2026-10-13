import { json, requireUser } from "@/lib/api";
import { UUID_RE } from "@/gateway/protocol";
import { getPairRequest } from "@/lib/devices";

/** A pairing request's state, so the device can pick up the host's nonce if it missed the live update. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await requireUser();
  if ("error" in u) return u.error;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return json({ error: "not_found" }, 404);
  const r = await getPairRequest(u.userId, id);
  return r ? json({ request: r }) : json({ error: "not_found" }, 404);
}
