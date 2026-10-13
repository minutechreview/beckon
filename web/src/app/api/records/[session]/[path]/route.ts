import { z } from "zod";
import { json, requireUser } from "@/lib/api";
import { validPath } from "@/gateway/protocol";
import { getRecord, getSession } from "@/lib/queries";

export const dynamic = "force-dynamic";

/**
 * One record, for the service worker: it fetches this after a push, then
 * decrypts `enc_body` locally, and the session's `enc_meta` for its label.
 * The root record ('') is addressed as "~".
 */
export async function GET(_req: Request, ctx: { params: Promise<{ session: string; path: string }> }) {
  const u = await requireUser();
  if ("error" in u) return u.error;
  const p = await ctx.params;
  const path = p.path === "~" ? "" : decodeURIComponent(p.path);
  if (!z.string().uuid().safeParse(p.session).success || !validPath(path)) return json({ error: "not_found" }, 404);
  const [record, session] = await Promise.all([getRecord(u.userId, p.session, path), getSession(u.userId, p.session)]);
  if (!record || !session) return json({ error: "not_found" }, 404);
  return json({ record, host_id: session.host_id, enc_meta: session.enc_meta });
}
