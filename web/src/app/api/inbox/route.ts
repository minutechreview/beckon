import { json, requireUser } from "@/lib/api";
import { inbox } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET() {
  const u = await requireUser();
  if ("error" in u) return u.error;
  return json({ items: await inbox(u.userId) });
}
