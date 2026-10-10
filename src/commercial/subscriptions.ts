import type { Env } from "../types";
import { id, isoNow } from "../lib/ids";

export async function createSubscription(
  env: Env,
  input: { accountId: string; productCode: string; cadence?: string; renewsAt?: string | null; metadata?: Record<string, unknown> }
): Promise<string> {
  const subscriptionId = id("sub");
  await env.DB.prepare(
    `INSERT INTO subscriptions (
      subscription_id,account_id,product_code,status,cadence,started_at,renews_at,metadata_json
    ) VALUES (?,?,?,'active',?,?,?,?)`
  ).bind(subscriptionId, input.accountId, input.productCode, input.cadence || "monthly", isoNow(), input.renewsAt || null, JSON.stringify(input.metadata || {})).run();
  return subscriptionId;
}

export async function configureRoutingDestination(
  env: Env,
  input: { code: string; label: string; categories: string[]; description?: string | null; metadata?: Record<string, unknown> }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO routing_destinations (destination_code,label,categories_json,description,active,metadata_json)
     VALUES (?,?,?,?,1,?)
     ON CONFLICT(destination_code) DO UPDATE SET
       label=excluded.label,categories_json=excluded.categories_json,description=excluded.description,
       active=1,metadata_json=excluded.metadata_json`
  ).bind(input.code, input.label, JSON.stringify(input.categories), input.description || null, JSON.stringify(input.metadata || {})).run();
}

export async function subscribeNewsletter(
  env: Env,
  input: { email: string; problemCategory?: string | null; source?: string | null; consent: Record<string, unknown> }
): Promise<string> {
  if (!input.email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(input.email)) throw new Error("invalid_email");
  if (input.consent?.newsletter !== true) throw new Error("newsletter_consent_required");
  const existing = await env.DB.prepare("SELECT subscriber_id FROM newsletter_subscribers WHERE email=? LIMIT 1")
    .bind(input.email.toLowerCase()).first<{ subscriber_id: string }>();
  const now = isoNow();
  if (existing) {
    await env.DB.prepare(
      "UPDATE newsletter_subscribers SET problem_category=?,source=?,consent_json=?,status='active',updated_at=? WHERE subscriber_id=?"
    ).bind(input.problemCategory || null, input.source || null, JSON.stringify(input.consent), now, existing.subscriber_id).run();
    return existing.subscriber_id;
  }
  const subscriberId = id("subscriber");
  await env.DB.prepare(
    `INSERT INTO newsletter_subscribers (
      subscriber_id,email,problem_category,source,consent_json,status,created_at,updated_at
    ) VALUES (?,?,?,?,?,'active',?,?)`
  ).bind(subscriberId, input.email.toLowerCase(), input.problemCategory || null, input.source || null, JSON.stringify(input.consent), now, now).run();
  return subscriberId;
}

export async function sendNewsletterAsset(env: Env, assetId: string): Promise<{ attempted: number; sent: number }> {
  if (!env.RESEND_API_KEY) return { attempted: 0, sent: 0 };
  const asset = await env.DB.prepare("SELECT * FROM content_assets WHERE asset_id=?").bind(assetId).first<any>();
  if (!asset) throw new Error("asset_not_found");
  const draft = JSON.parse(asset.draft_json || "{}") as any;
  const subscribers = await env.DB.prepare("SELECT * FROM newsletter_subscribers WHERE status='active' LIMIT 500").all<any>();
  let sent = 0;
  for (const subscriber of subscribers.results) {
    const deliveryId = id("delivery");
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        from: env.ALERT_EMAIL_FROM || "ClientMotive Signals <clientmotive@clientmotive.com>",
        to: [subscriber.email],
        subject: String(draft.title || asset.title),
        text: String(draft.draft || draft.thesis || ""),
        headers: { "List-Unsubscribe": "<mailto:contact@clientmotive.com?subject=unsubscribe>" }
      })
    });
    const provider = await response.json().catch(() => ({})) as any;
    await env.DB.prepare(
      "INSERT INTO newsletter_deliveries (delivery_id,asset_id,subscriber_id,status,provider_id,error,sent_at,created_at) VALUES (?,?,?,?,?,?,?,?)"
    ).bind(deliveryId, assetId, subscriber.subscriber_id, response.ok ? "sent" : "failed", provider.id || null, response.ok ? null : "resend_" + response.status, response.ok ? isoNow() : null, isoNow()).run();
    if (response.ok) sent += 1;
  }
  return { attempted: subscribers.results.length, sent };
}
