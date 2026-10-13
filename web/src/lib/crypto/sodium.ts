import type Sodium from "libsodium-wrappers";

// libsodium is loaded on first use rather than imported up front, so the
// browser can paint the app before it fetches and compiles the (large) module.
let mod: typeof Sodium | null = null;
let ready: Promise<typeof Sodium> | null = null;

/** libsodium, initialised. Every crypto function in this directory needs it first. */
export function sodiumReady(): Promise<typeof Sodium> {
  return (ready ??= import("libsodium-wrappers").then(async (m) => {
    const sodium = (m.default ?? m) as typeof Sodium;
    await sodium.ready;
    return (mod = sodium);
  }));
}

/** The initialised module; throws if sodiumReady() has not resolved yet. */
export function S(): typeof Sodium {
  // crypto_box_seal is only defined once the wasm/asm module has loaded.
  if (!mod || typeof mod.crypto_box_seal !== "function") throw new Error("libsodium not ready: await sodiumReady() first");
  return mod;
}
