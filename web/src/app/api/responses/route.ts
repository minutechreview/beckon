import { json, requireUser } from "@/lib/api";
import { responseBody, submitResponse } from "@/lib/responses";

export const dynamic = "force-dynamic";

/**
 * A device's signed answer to a blocked record (SPEC §7.4). 202 when it is
 * on its way to the host; 409 (rejected_stale, or rejected_sig) when the
 * server refuses it; 429 past 10 a minute per device. The helper decides
 * whether anything is typed, after its own checks.
 */
export async function POST(req: Request) {
  const u = await requireUser();
  if ("error" in u) return u.error;
  const parsed = responseBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_request" }, 400);
  const out = await submitResponse(u.userId, parsed.data);
  switch (out.http) {
    case 202: return json({ response: out.response }, 202);
    case 409: return json({ error: "rejected", status: out.status, response: out.response ?? null }, 409);
    case 429: return json({ error: out.error }, 429);
  }
}
