import { json, requireUser } from "@/lib/api";
import { UUID_RE } from "@/gateway/protocol";
import { pubsub } from "@/gateway/pubsub";
import { dismissEndedSessions, getHost } from "@/lib/queries";

/** Removes every ended session of one host from the user's lists. Live sessions stay. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await requireUser();
  if ("error" in u) return u.error;
  const { id } = await ctx.params;
  const host = UUID_RE.test(id) ? await getHost(u.userId, id) : null;
  if (!host || host.revoked) return json({ error: "not_found" }, 404);
  const dismissed = await dismissEndedSessions(u.userId, { hostId: id });
  for (const s of dismissed) await pubsub().publish({ k: "session.removed", u: u.userId, s });
  return json({ dismissed });
}
