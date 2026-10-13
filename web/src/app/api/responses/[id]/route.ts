import { json, requireUser } from "@/lib/api";
import { UUID_RE } from "@/gateway/protocol";
import { getResponse } from "@/lib/responses";

export const dynamic = "force-dynamic";

/** One of the user's responses: the service worker polls this after a notification action. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await requireUser();
  if ("error" in u) return u.error;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return json({ error: "not_found" }, 404);
  const response = await getResponse(u.userId, id);
  return response ? json({ response }) : json({ error: "not_found" }, 404);
}
