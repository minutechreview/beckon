import { z } from "zod";
import { json, requireUser } from "@/lib/api";
import { UUID_RE } from "@/gateway/protocol";
import { DomainError, revokeDevice } from "@/lib/devices";

// Optional: the revoking device's signed statement, which hosts verify
// against its pinned key (SPEC §8.4).
const body = z.object({
  signed: z
    .object({
      by_device_id: z.string().regex(UUID_RE),
      issued_at: z.string().min(1).max(64),
      signature: z.string().max(128),
    })
    .optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await requireUser();
  if ("error" in u) return u.error;
  const { id } = await ctx.params;
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return json({ error: "invalid_request" }, 400);
  if (!UUID_RE.test(id)) return json({ error: "not_found" }, 404);
  try {
    const device = await revokeDevice(u.userId, id, parsed.data.signed);
    return device ? json({ device }) : json({ error: "not_found" }, 404);
  } catch (err) {
    if (err instanceof DomainError) return json({ error: err.code }, err.status);
    throw err;
  }
}
