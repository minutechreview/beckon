// A tiny bounded cache for decrypted envelopes: enough for everything on
// screen, bounded for tabs left open for days.
export const CACHE_MAX = 1000;

/** Get-or-compute with oldest-first eviction (Map keeps insertion order; hits move to the back). */
export function cached<T>(cache: Map<string, unknown>, key: string, compute: () => T, max = CACHE_MAX): T {
  if (cache.has(key)) {
    const v = cache.get(key) as T;
    cache.delete(key);
    cache.set(key, v);
    return v;
  }
  const v = compute();
  cache.set(key, v);
  while (cache.size > max) cache.delete(cache.keys().next().value!);
  return v;
}
