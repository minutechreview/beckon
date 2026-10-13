import { z } from "zod";
import { json, requireUser } from "@/lib/api";
import { validPath } from "@/gateway/protocol";
import { pubsub } from "@/gateway/pubsub";
import { setDismissed } from "@/lib/queries";

// The inbox shows at most 200 records (lib/queries.ts, inbox), so "Clear all" never needs more.
const body = z.object({
  records: z.array(z.object({ session_id: z.string().uuid(), path: z.string().refine(validPath) })).min(1).max(200),
  dismissed: z.boolean().default(true),
});

/** Dismisses several records at once (a swipe, Dismiss, "Clear all"), or brings them back (Undo). */
export async function POST(req: Request) {
  const u = await requireUser();
  if ("error" in u) return u.error;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request" }, 400);
  const records = await setDismissed(u.userId, parsed.data.records, parsed.data.dismissed);
  for (const r of records) await pubsub().publish({ k: "record.changed", u: u.userId, s: r.session_id, p: r.path });
  return json({ records });
}
