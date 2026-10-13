import { json, requireUser } from "@/lib/api";
import { hostsTree } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET() {
  const u = await requireUser();
  if ("error" in u) return u.error;
  return json({ hosts: await hostsTree(u.userId) });
}
