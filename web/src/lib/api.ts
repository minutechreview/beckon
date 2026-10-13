import { NextResponse } from "next/server";
import { eq, and, isNull } from "drizzle-orm";
import { auth } from "@/auth";
import { db, schema } from "@/db";
import { hashToken } from "@/lib/tokens";

/** The signed-in user's id, or a 401 response. */
export async function requireUser(): Promise<{ userId: string } | { error: NextResponse }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  return { userId };
}

export async function hostFromBearer(req: Request) {
  const m = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "");
  if (!m) return null;
  const [h] = await db()
    .select()
    .from(schema.hosts)
    .where(and(eq(schema.hosts.tokenHash, hashToken(m[1])), isNull(schema.hosts.revokedAt)));
  return h ?? null;
}

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status });
