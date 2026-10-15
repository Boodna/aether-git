import { currentKey } from "./keys";

export interface Session {
  sub: string;
  exp: number;
}

export async function verifySession(token: string): Promise<Session | null> {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const key = await currentKey();
  const ok = await crypto.subtle.verify("HMAC", key, base64UrlDecode(signature), new TextEncoder().encode(payload));
  if (!ok) return null;
  const session = JSON.parse(atob(payload)) as Session;
  return session.exp > Date.now() / 1000 ? session : null;
}

export function base64UrlDecode(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
