import { z } from "zod";
import { json, requireUser } from "@/lib/api";
import { notifier } from "@/lib/notify";

/** "Send test notification": pushes to every subscribed device (or one), regardless of quiet hours. */
export async function POST(req: Request) {
  const u = await requireUser();
  if ("error" in u) return u.error;
  const parsed = z.object({ device_id: z.string().uuid().optional() }).safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return json({ error: "invalid_request" }, 400);
  const n = notifier();
  if (!n.pushConfigured) return json({ error: "push_not_configured" }, 503);
  const results = await n.sendTest(u.userId, "Beckon", parsed.data.device_id);
  return json({ results });
}
