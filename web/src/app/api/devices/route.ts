import { z } from "zod";
import { json, requireUser } from "@/lib/api";
import { deviceName, DomainError, listDevices, publicKey, registerDevice } from "@/lib/devices";

export const dynamic = "force-dynamic";

export async function GET() {
  const u = await requireUser();
  if ("error" in u) return u.error;
  return json({ devices: await listDevices(u.userId) });
}

const body = z.object({ name: deviceName, sign_pubkey: publicKey, box_pubkey: publicKey });

/** Registers this browser's public keys (idempotent for the same keys). */
export async function POST(req: Request) {
  const u = await requireUser();
  if ("error" in u) return u.error;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_request" }, 400);
  try {
    return json({ device: await registerDevice(u.userId, parsed.data) });
  } catch (err) {
    if (err instanceof DomainError) return json({ error: err.code }, err.status);
    throw err;
  }
}
