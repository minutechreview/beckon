import { handlers } from "@/auth";
import { ipLimit } from "@/lib/ratelimit";

export const { GET } = handlers;

/** Sign-in attempts (magic-link sends, OAuth starts, credential posts) are limited per address. */
export async function POST(req: Request) {
  const limited = await ipLimit(req, "signin", 20, 10 * 60_000);
  if (limited) return limited;
  return handlers.POST(req as Parameters<typeof handlers.POST>[0]);
}
