import { z } from "zod";
import { json, requireUser } from "@/lib/api";
import { sessionDetail } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await requireUser();
  if ("error" in u) return u.error;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return json({ error: "not_found" }, 404);
  // Someone else's session is indistinguishable from a missing one.
  const detail = await sessionDetail(u.userId, id);
  return detail ? json(detail) : json({ error: "not_found" }, 404);
}
