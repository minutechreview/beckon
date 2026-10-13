import { z } from "zod";
import { auth } from "@/auth";
import { SessionDetail, type SessionHistory } from "@/components/SessionDetail";
import { sessionDetail } from "@/lib/queries";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ r?: string }>;
}) {
  const { id } = await params;
  const { r } = await searchParams;
  return <SessionDetail id={id} focusPath={typeof r === "string" ? r : undefined} first={await firstHistory(id)} />;
}

/**
 * The history GET /api/sessions/:id returns, loaded with the same user-scoped query so the page needs no
 * request after it loads. Someone else's session is "missing", exactly as the API's 404. On a database error
 * the page loads it from the API instead.
 */
async function firstHistory(id: string): Promise<SessionHistory | "missing" | undefined> {
  const session = await auth();
  if (!session?.user) return undefined; // the layout redirects
  if (!z.string().uuid().safeParse(id).success) return "missing";
  try {
    const d = await sessionDetail(session.user.id, id);
    return d ? { events: d.events, responses: d.responses } : "missing";
  } catch (e) {
    console.error("[app] session history failed", e);
    return undefined;
  }
}
