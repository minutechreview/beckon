import { json, requireUser } from "@/lib/api";

export const dynamic = "force-dynamic";

/** The VAPID public key the browser subscribes with, or `configured: false` if this server has none. */
export async function GET() {
  const u = await requireUser();
  if ("error" in u) return u.error;
  const key = process.env.VAPID_PUBLIC_KEY;
  return json(key && process.env.VAPID_PRIVATE_KEY ? { configured: true, public_key: key } : { configured: false });
}
