import type { Env } from "../types";
import { id, isoNow } from "../lib/ids";
import { aiJson } from "../services/ai";

export async function recordOutcome(
  env: Env,
  input: { opportunityId: string; outcomeType: "meeting" | "proposal" | "won" | "lost" | "expanded" | "renewed"; value?: number | null; reason?: string | null; details?: Record<string, unknown> }
): Promise<string> {
  const outcomeId = id("outcome");
  await env.DB.prepare(
    "INSERT INTO opportunity_outcomes (outcome_id, opportunity_id, outcome_type, value, reason, details_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(outcomeId, input.opportunityId, input.outcomeType, input.value || null, input.reason || null, JSON.stringify(input.details || {}), isoNow()).run();
  const stage = input.outcomeType === "won" ? "won" : input.outcomeType === "lost" ? "lost" : input.outcomeType === "proposal" ? "proposal" : null;
  if (stage) {
    await env.DB.prepare(
      "UPDATE opportunities SET stage = ?, value_estimate = COALESCE(?, value_estimate), probability = ?, last_activity_at = ?, updated_at = ? WHERE opportunity_id = ?"
    ).bind(stage, input.value || null, stage === "won" ? 100 : stage === "lost" ? 0 : 70, isoNow(), isoNow(), input.opportunityId).run();
  }
  return outcomeId;
}

export async function recordObjection(
  env: Env,
  input: { opportunityId?: string | null; leadId?: string | null; category: string; text: string; buyerRole?: string | null; segment?: string | null; messageVariant?: string | null; response?: string | null }
): Promise<string> {
  const objectionId = id("obj");
  await env.DB.prepare(
    `INSERT INTO objections (
      objection_id, opportunity_id, lead_id, category, objection_text, buyer_role,
      segment, message_variant, response_text, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    objectionId, input.opportunityId || null, input.leadId || null, input.category,
    input.text, input.buyerRole || null, input.segment || null, input.messageVariant || null,
    input.response || null, isoNow()
  ).run();
  return objectionId;
}

export async function pricingIntelligence(env: Env, segment?: string | null): Promise<Record<string, unknown>> {
  const params: unknown[] = [];
  let where = "WHERE oo.outcome_type = 'won' AND oo.value IS NOT NULL";
  if (segment) {
    where += " AND a.segment = ?";
    params.push(segment);
  }
  const rows = await env.DB.prepare(
    `SELECT oo.value, a.segment, o.created_at, oo.occurred_at
     FROM opportunity_outcomes oo
     JOIN opportunities o ON o.opportunity_id = oo.opportunity_id
     JOIN commercial_accounts a ON a.account_id = o.account_id
     ${where}
     ORDER BY oo.value`
  ).bind(...params).all<any>();
  const values = rows.results.map((row) => Number(row.value)).filter(Number.isFinite).sort((a,b)=>a-b);
  if (values.length < 3) {
    return {
      sampleSize: values.length,
      recommendation: "Insufficient won-deal history to make a pricing recommendation.",
      safeToAutomatePricing: false
    };
  }
  const median = values[Math.floor(values.length / 2)]!;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    sampleSize: values.length,
    medianWonValue: Math.round(median * 100) / 100,
    averageWonValue: Math.round(average * 100) / 100,
    range: [values[0], values[values.length - 1]],
    recommendation: "Use this only as historical context; pricing still requires human scope and margin review.",
    safeToAutomatePricing: false
  };
}

export async function scoreClientHealth(
  env: Env,
  accountId: string,
  metrics: { delivery?: number; outcomes?: number; engagement?: number; payment?: number; outstandingDecisions?: number; expansionSignals?: number }
): Promise<Record<string, unknown>> {
  const positive =
    (metrics.delivery ?? 50) * 0.25 +
    (metrics.outcomes ?? 50) * 0.30 +
    (metrics.engagement ?? 50) * 0.20 +
    (metrics.payment ?? 50) * 0.15 +
    (metrics.expansionSignals ?? 30) * 0.10;
  const friction = Math.max(0, Math.min(100, metrics.outstandingDecisions ?? 0));
  const health = Math.max(0, Math.min(100, Math.round(positive - friction * 0.2)));
  const renewalRisk = Math.max(0, Math.min(100, 100 - health + Math.round(friction * 0.25)));
  const expansionScore = Math.max(0, Math.min(100, Math.round((metrics.outcomes ?? 50) * 0.45 + (metrics.expansionSignals ?? 30) * 0.4 + (metrics.engagement ?? 50) * 0.15)));
  const reasons = [
    health < 45 ? "Client health is weak enough to require intervention before expansion." : null,
    renewalRisk > 65 ? "Renewal risk is elevated." : null,
    expansionScore > 70 ? "There are strong signals for a value-led expansion conversation." : null
  ].filter(Boolean);
  await env.DB.prepare(
    `INSERT INTO client_health (account_id, health_score, renewal_risk, expansion_score, reasons_json, metrics_json, scored_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       health_score=excluded.health_score, renewal_risk=excluded.renewal_risk,
       expansion_score=excluded.expansion_score, reasons_json=excluded.reasons_json,
       metrics_json=excluded.metrics_json, scored_at=excluded.scored_at`
  ).bind(accountId, health, renewalRisk, expansionScore, JSON.stringify(reasons), JSON.stringify(metrics), isoNow()).run();
  return { accountId, healthScore: health, renewalRisk, expansionScore, reasons };
}

export async function expansionSuggestions(env: Env, accountId: string): Promise<Record<string, unknown>> {
  const [account, subscriptions, signals, health] = await Promise.all([
    env.DB.prepare("SELECT * FROM commercial_accounts WHERE account_id = ?").bind(accountId).first<any>(),
    env.DB.prepare("SELECT s.*, p.name AS product_name FROM subscriptions s JOIN commercial_products p ON p.product_code=s.product_code WHERE s.account_id=? AND s.status='active'").bind(accountId).all<any>(),
    env.DB.prepare("SELECT * FROM commercial_signals WHERE account_id=? ORDER BY captured_at DESC LIMIT 20").bind(accountId).all<any>(),
    env.DB.prepare("SELECT * FROM client_health WHERE account_id=?").bind(accountId).first<any>()
  ]);
  if (!account) throw new Error("account_not_found");
  const products = await env.DB.prepare("SELECT * FROM commercial_products WHERE active=1 ORDER BY category").all<any>();
  return aiJson<Record<string, unknown>>(
    env,
    "You are an account-growth strategist. Recommend expansion only when it creates additional client value. Never recommend expansion to a client with poor health merely to increase revenue.",
    `ACCOUNT: ${JSON.stringify(account)}\nACTIVE PRODUCTS: ${JSON.stringify(subscriptions.results)}\nHEALTH: ${JSON.stringify(health || {})}\nRECENT SIGNALS: ${JSON.stringify(signals.results)}\nAVAILABLE PRODUCTS: ${JSON.stringify(products.results)}\nReturn readiness, ideas[{productCode,reason,evidence,nextStep}], doNotSellReason|null.`,
    {
      readiness: health && health.health_score < 50 ? "not_ready" : "review",
      ideas: [],
      doNotSellReason: health && health.health_score < 50 ? "Improve delivery/client health before proposing expansion." : null
    }
  );
}

export async function recordReferral(
  env: Env,
  input: { referrerType: string; referrerId: string; referredAccountId?: string | null; referredName?: string | null; referralCode?: string | null; metadata?: Record<string, unknown> }
): Promise<string> {
  const referralId = id("ref");
  const now = isoNow();
  await env.DB.prepare(
    `INSERT INTO referrals (
      referral_id, referrer_type, referrer_id, referred_account_id, referred_name,
      referral_code, status, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'introduced', ?, ?, ?)`
  ).bind(referralId, input.referrerType, input.referrerId, input.referredAccountId || null, input.referredName || null, input.referralCode || null, JSON.stringify(input.metadata || {}), now, now).run();
  return referralId;
}

export async function routeCommercialNeed(
  env: Env,
  input: { leadId?: string | null; accountId?: string | null; needCategory: string; context: string }
): Promise<Record<string, unknown>> {
  const destinations = await env.DB.prepare("SELECT * FROM routing_destinations WHERE active=1").all<any>();
  const matches = destinations.results.filter((row) => {
    const categories = JSON.parse(row.categories_json || "[]") as string[];
    return categories.some((category) => input.needCategory.toLowerCase().includes(String(category).toLowerCase()));
  });
  if (!matches.length) return { routed: false, reason: "No configured destination matches this need category." };
  const destination = matches[0];
  const suggestionId = id("route");
  await env.DB.prepare(
    `INSERT INTO routing_suggestions (
      suggestion_id, lead_id, account_id, destination_code, need_category, rationale,
      confidence, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 70, 'suggested', ?)`
  ).bind(suggestionId, input.leadId || null, input.accountId || null, destination.destination_code, input.needCategory, input.context, isoNow()).run();
  return { routed: true, suggestionId, destinationCode: destination.destination_code, label: destination.label, humanApprovalRequired: true };
}


export async function recordAccountMetric(
  env: Env,
  accountId: string,
  input: { name: string; value: number; metadata?: Record<string, unknown>; occurredAt?: string }
): Promise<string> {
  if (!Number.isFinite(input.value)) throw new Error("invalid_metric_value");
  const metricId = id("metric");
  await env.DB.prepare(
    "INSERT INTO account_metrics (metric_id,account_id,metric_name,numeric_value,metadata_json,occurred_at) VALUES (?,?,?,?,?,?)"
  ).bind(metricId, accountId, input.name, input.value, JSON.stringify(input.metadata || {}), input.occurredAt || isoNow()).run();
  return metricId;
}

export async function scoreHealthFromStoredMetrics(env: Env, accountId: string): Promise<Record<string, unknown>> {
  const rows = await env.DB.prepare(
    `SELECT metric_name,numeric_value FROM account_metrics
     WHERE account_id=? AND occurred_at >= datetime('now','-90 days')
     ORDER BY occurred_at DESC`
  ).bind(accountId).all<{ metric_name: string; numeric_value: number }>();
  const latest = new Map<string, number>();
  for (const row of rows.results) if (!latest.has(row.metric_name)) latest.set(row.metric_name, Number(row.numeric_value));
  return scoreClientHealth(env, accountId, {
    delivery: latest.get("delivery"),
    outcomes: latest.get("outcomes"),
    engagement: latest.get("engagement"),
    payment: latest.get("payment"),
    outstandingDecisions: latest.get("outstanding_decisions"),
    expansionSignals: latest.get("expansion_signals")
  });
}
