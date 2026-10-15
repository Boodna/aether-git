let cached: CryptoKey | null = null;

export async function currentKey(): Promise<CryptoKey> {
  if (cached) return cached;
  const raw = new TextEncoder().encode("dev-secret-do-not-ship");
  cached = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return cached;
}
