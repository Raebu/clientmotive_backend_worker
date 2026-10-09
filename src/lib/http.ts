export function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders
    }
  });
}

export function error(message: string, status = 400, code = "bad_request"): Response {
  return json({ error: message, code }, status);
}

export async function readJson<T>(request: Request, maxBytes = 100_000): Promise<T> {
  const length = Number(request.headers.get("content-length") || "0");
  if (length > maxBytes) throw new Error("payload_too_large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("payload_too_large");
  return JSON.parse(text) as T;
}

export function corsHeaders(origin: string | null, allowedOrigin: string): HeadersInit {
  if (!origin || origin !== allowedOrigin) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-clientmotive-signature,x-idempotency-key,authorization",
    "access-control-max-age": "86400",
    vary: "Origin"
  };
}
