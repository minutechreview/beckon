import { json, hostFromBearer } from "@/lib/api";
import { hostDecision, userPlan } from "@/lib/plans";

export const dynamic = "force-dynamic";

/** Lets `beckon status` and `beckon doctor` check the token; `server_time` (ms) is for clock-skew checks. */
export async function GET(req: Request) {
  const host = await hostFromBearer(req);
  if (!host) return json({ error: "unauthorized" }, 401);
  const d = await hostDecision(host);
  return json({
    // `allowed: false` means the plan's host limit excludes this host; the helper says so before it
    // starts the command (which then runs unchanged).
    plan: await userPlan(host.userId),
    allowed: d.allowed,
    ...(d.reason ? { reason: d.reason } : {}),
    host_id: host.id,
    label: host.label,
    last_seen_at: host.lastSeenAt?.toISOString() ?? null,
    server_time: Date.now(),
  });
}
