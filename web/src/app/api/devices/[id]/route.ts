import { z } from "zod";
import { json, requireUser } from "@/lib/api";
import { UUID_RE } from "@/gateway/protocol";
import { deviceName, renameDevice } from "@/lib/devices";

const body = z.object({ name: deviceName });

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await requireUser();
  if ("error" in u) return u.error;
  const { id } = await ctx.params;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_request" }, 400);
  const device = UUID_RE.test(id) ? await renameDevice(u.userId, id, parsed.data.name) : null;
  return device ? json({ device }) : json({ error: "not_found" }, 404);
}
