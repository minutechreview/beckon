// This browser's device keys and pinned host keys, in IndexedDB.
//
// libsodium needs raw key bytes, so the secret keys cannot themselves be
// non-extractable CryptoKeys. Instead they are stored encrypted under an
// AES-GCM key that *is* a non-extractable CryptoKey (SPEC §8.1, "wrapped
// otherwise"): page script can use it to unwrap, but cannot read the AES key
// out through the Web Crypto API.
// This is not encryption at rest. The browser stores the AES key's raw bytes
// in the same profile's IndexedDB, so anyone with a copy of the profile files
// (malware, a backup, another user of the machine) can recover the device
// secrets. Script running in the page (XSS) can still use the keys. See
// SECURITY.md, "Keys" and "Known limitations".
import { generateKeyPairs, type KeyPairs } from "@/lib/crypto/keys";
import { concat } from "@/lib/crypto/bytes";

const DB_NAME = "beckon";
const STORE = "kv";

interface StoredDevice {
  deviceId: string | null;
  signPub: Uint8Array;
  boxPub: Uint8Array;
  wrapKey: CryptoKey; // AES-GCM, extractable: false
  iv: Uint8Array;
  wrapped: ArrayBuffer; // AES-GCM(sign_secret[64] || box_secret[32])
}

/** A host's keys as this device pinned them after the safety codes matched. */
export interface Pin {
  sign_pubkey: string; // base64url
  box_pubkey: string;
  label: string;
  pinned_at: string;
}

export interface LocalDevice {
  deviceId: string | null;
  keys: KeyPairs;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

const get = <T>(key: string) => tx<T>("readonly", (s) => s.get(key) as IDBRequest<T>);
const put = (key: string, value: unknown) => tx("readwrite", (s) => void s.put(value, key));
const del = (key: string) => tx("readwrite", (s) => void s.delete(key));

const deviceKey = (userId: string) => `device:${userId}`;
const pinsKey = (userId: string) => `pins:${userId}`;

async function unwrap(d: StoredDevice): Promise<LocalDevice> {
  const secret = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: d.iv as BufferSource }, d.wrapKey, d.wrapped));
  return {
    deviceId: d.deviceId,
    keys: { sign_pubkey: d.signPub, sign_secret: secret.slice(0, 64), box_pubkey: d.boxPub, box_secret: secret.slice(64, 96) },
  };
}

async function create(userId: string): Promise<LocalDevice> {
  const keys = generateKeyPairs();
  const wrapKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrapKey, concat(keys.sign_secret, keys.box_secret) as BufferSource);
  const stored: StoredDevice = { deviceId: null, signPub: keys.sign_pubkey, boxPub: keys.box_pubkey, wrapKey, iv, wrapped };
  await put(deviceKey(userId), stored);
  return { deviceId: null, keys };
}

/**
 * Read-only: this browser's keys if they exist, never creating any. The service
 * worker uses this; it must not mint a device identity of its own.
 */
export async function loadDevice(userId: string): Promise<LocalDevice | null> {
  const d = await get<StoredDevice>(deviceKey(userId));
  return d ? unwrap(d) : null;
}

/** Which account and device this browser's push subscription belongs to, for the worker's pushsubscriptionchange. */
export interface PushMeta { userId: string; deviceId: string }
export const loadPushMeta = () => get<PushMeta>("push-meta");
export const savePushMeta = (m: PushMeta) => put("push-meta", m);
export const clearPushMeta = () => del("push-meta");

/** Loads this browser's keys for the user, generating them on first sign-in. Needs sodiumReady(). */
export async function loadOrCreateDevice(userId: string): Promise<LocalDevice> {
  const run = async () => {
    const d = await get<StoredDevice>(deviceKey(userId));
    return d ? unwrap(d) : create(userId);
  };
  // Two tabs on first sign-in must not create two devices.
  return navigator.locks ? navigator.locks.request(`beckon-device-${userId}`, run) : run();
}

export async function saveDeviceId(userId: string, deviceId: string) {
  const d = await get<StoredDevice>(deviceKey(userId));
  if (d) await put(deviceKey(userId), { ...d, deviceId });
}

/** Forgets this browser's keys and pins (e.g. after the device was revoked). */
export async function resetDevice(userId: string) {
  await del(deviceKey(userId));
  await del(pinsKey(userId));
}

export async function loadPins(userId: string): Promise<Record<string, Pin>> {
  return (await get<Record<string, Pin>>(pinsKey(userId))) ?? {};
}

export async function savePins(userId: string, pins: Record<string, Pin>) {
  await put(pinsKey(userId), pins);
}
