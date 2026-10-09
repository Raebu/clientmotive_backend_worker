import type { Env } from "../types";

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyWebsiteSignature(request: Request, body: string, env: Env): Promise<boolean> {
  if (!env.WEBSITE_SHARED_SECRET) return false;
  const signature = request.headers.get("x-clientmotive-signature") || "";
  const expected = await hmacSha256(env.WEBSITE_SHARED_SECRET, body);
  return timingSafeEqual(signature.toLowerCase(), expected.toLowerCase());
}

export function verifyAdmin(request: Request, env: Env): boolean {
  if (!env.ADMIN_API_TOKEN) return false;
  const header = request.headers.get("authorization") || "";
  return timingSafeEqual(header, "Bearer " + env.ADMIN_API_TOKEN);
}

export async function hashValue(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
