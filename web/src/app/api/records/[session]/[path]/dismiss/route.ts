import { z } from "zod";
import { json, requireUser } from "@/lib/api";
import { validPath } from "@/gateway/protocol";
import { pubsub } from "@/gateway/pubsub";
import { dismissRecord } from "@/lib/queries";

/** The root record ('' ) is addressed as "~" in the URL, which can't occur in a real path. */
const ROOT_PATH_SEGMENT = "~";

export async function POST(_req: Request, ctx: { params: Promise<{ session: string; path: string }> }) {
  const u = await requireUser();
  if ("error" in u) return u.error;
  const p = await ctx.params;
  const path = p.path === ROOT_PATH_SEGMENT ? "" : decodeURIComponent(p.path);
  if (!z.string().uuid().safeParse(p.session).success || !validPath(path)) {
    return json({ error: "not_found" }, 404);
  }
  const record = await dismissRecord(u.userId, p.session, path);
  if (!record) return json({ error: "not_found" }, 404);
  await pubsub().publish({ k: "record.changed", u: u.userId, s: p.session, p: path });
  return json({ record });
}
