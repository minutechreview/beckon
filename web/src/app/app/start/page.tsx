import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db, schema } from "@/db";

export const dynamic = "force-dynamic";

/**
 * Where sign-in lands: a user with no host yet goes straight into the setup guide (SPEC §12 M7),
 * everyone else to the inbox.
 */
export default async function Start() {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin?callbackUrl=%2Fapp%2Fstart");
  const [h] = await db().select({ id: schema.hosts.id }).from(schema.hosts).where(eq(schema.hosts.userId, session.user.id)).limit(1);
  redirect(h ? "/app" : "/app/settings/setup-guide");
}
