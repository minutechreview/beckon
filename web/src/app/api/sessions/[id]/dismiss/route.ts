import { json, requireUser } from "@/lib/api";
import { UUID_RE } from "@/gateway/protocol";
import { pubsub } from "@/gateway/pubsub";
import { dismissEndedSessions, getSession } from "@/lib/queries";

/** Removes an ended session from the user's lists. A live session can't be dismissed: its prompts would be hidden. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await requireUser();
  if ("error" in u) return u.error;
  const { id } = await ctx.params;
  const session = UUID_RE.test(id) ? await getSession(u.userId, id) : null;
  if (!session) return json({ error: "not_found" }, 404);
  if (!session.ended_at) return json({ error: "session_live" }, 409);
  const dismissed = await dismissEndedSessions(u.userId, { sessionId: id });
  for (const s of dismissed) await pubsub().publish({ k: "session.removed", u: u.userId, s });
  return json({ dismissed });
}
