import type { Env } from "../types";
import { id, isoNow } from "../lib/ids";
import { hashValue, timingSafeEqual } from "../lib/security";

export async function createApiClient(
  env: Env,
  input: { name: string; scopes: string[]; monthlyLimit?: number }
): Promise<{ clientId: string; apiKey: string }> {
  const clientId = id("client");
  const apiKey = "cm_" + crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const hash = await hashValue(apiKey);
  await env.DB.prepare(
    `INSERT INTO api_clients (
      client_id, name, api_key_hash, scopes_json, status, monthly_limit, created_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?)`
  ).bind(clientId, input.name, hash, JSON.stringify(input.scopes), Math.max(1, Math.min(100000, input.monthlyLimit || 100)), isoNow()).run();
  return { clientId, apiKey };
}

export async function verifyApiClient(
  env: Env,
  request: Request,
  capability: string
): Promise<{ clientId: string; scopes: string[] } | null> {
  const apiKey = request.headers.get("x-api-key") || "";
  if (!apiKey.startsWith("cm_") || apiKey.length < 40) return null;
  const hash = await hashValue(apiKey);
  const row = await env.DB.prepare("SELECT * FROM api_clients WHERE api_key_hash = ? AND status='active' LIMIT 1")
    .bind(hash).first<any>();
  if (!row || !timingSafeEqual(row.api_key_hash, hash)) return null;
  const scopes = JSON.parse(row.scopes_json || "[]") as string[];
  if (!scopes.includes("*") && !scopes.includes(capability)) return null;
  const usage = await env.DB.prepare(
    "SELECT COALESCE(SUM(units),0) AS units FROM api_usage WHERE client_id=? AND occurred_at >= datetime('now','start of month')"
  ).bind(row.client_id).first<{ units: number }>();
  if (Number(usage?.units || 0) >= Number(row.monthly_limit || 100)) return null;
  await env.DB.prepare("UPDATE api_clients SET last_used_at=? WHERE client_id=?").bind(isoNow(), row.client_id).run();
  return { clientId: row.client_id, scopes };
}

export async function recordApiUsage(env: Env, clientId: string, capability: string, units = 1): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO api_usage (usage_id, client_id, capability, units, occurred_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(id("usage"), clientId, capability, Math.max(1, units), isoNow()).run();
}
