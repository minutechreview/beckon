import { eq } from "drizzle-orm";
import { z } from "zod";
import { signOut } from "@/auth";
import { db, schema } from "@/db";
import { json, requireUser } from "@/lib/api";
import { deleteAccount } from "@/lib/account";
import { BillingError } from "@/lib/billing";
import { rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const body = z.object({ confirm: z.string().max(320) });

/** Deletes the account and all its data. The caller must type the account's email address. */
export async function DELETE(req: Request) {
  const u = await requireUser();
  if ("error" in u) return u.error;
  const limited = await rateLimit("account-delete", u.userId, 5, 60_000);
  if (limited) return limited;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_request" }, 400);
  const [row] = await db().select().from(schema.users).where(eq(schema.users.id, u.userId));
  if (!row) return json({ error: "not_found" }, 404);
  if (parsed.data.confirm.trim().toLowerCase() !== row.email.toLowerCase()) {
    return json({ error: "confirmation_mismatch", message: "Type your account email to confirm." }, 400);
  }
  try {
    await deleteAccount(u.userId);
  } catch (err) {
    if (err instanceof BillingError) return json({ error: err.code, message: "Could not cancel your subscription; nothing was deleted." }, 502);
    throw err;
  }
  await signOut({ redirect: false });
  return json({ ok: true });
}
