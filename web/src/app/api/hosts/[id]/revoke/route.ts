import { json, requireUser } from "@/lib/api";
import { UUID_RE } from "@/gateway/protocol";
import { revokeHost } from "@/lib/devices";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await requireUser();
  if ("error" in u) return u.error;
  const { id } = await ctx.params;
  const ok = UUID_RE.test(id) && (await revokeHost(u.userId, id));
  return ok ? json({ ok: true }) : json({ error: "not_found" }, 404);
}
