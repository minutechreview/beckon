// The "paired hosts" hint cookie, shared by the server (app/app/layout.tsx reads it) and the browser
// (DeviceProvider writes it). Kept out of the "use client" module: a server component that imports a constant
// from one gets a client reference, not the string.
//
// Not a secret and not trusted: which hosts this browser holds keys for, so the server can render the right
// placeholders. The server already learns which devices pair with which hosts when it relays pairing.

export const PAIRED_COOKIE = "beckon_paired";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Host ids from the cookie's value. No cookie means a browser that has never paired. */
export function parsePairedHint(v: string | undefined): string[] {
  return (v ?? "").split(".").filter((id) => UUID.test(id)).slice(0, 100);
}

export function pairedCookie(hostIds: string[], secure: boolean): string {
  return `${PAIRED_COOKIE}=${[...hostIds].sort().join(".")}; Path=/app; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`;
}
