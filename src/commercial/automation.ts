import type { Env } from "../types";
import { addSignal, scanDueWatchlists, nextBestAccounts } from "./acquisition";
import { processDueNurture, rescueStaleOpportunities } from "./convert";
import { generateBenchmark, generateContentAsset, harvestContentInsights } from "./learn";
import { scoreHealthFromStoredMetrics } from "./growth";

async function refreshHealthAndExpansionSignals(env: Env): Promise<{ refreshed: number; alerts: number }> {
  const accounts = await env.DB.prepare(
    `SELECT DISTINCT account_id FROM account_metrics
     WHERE occurred_at >= datetime('now','-90 days')
     ORDER BY occurred_at DESC LIMIT 20`
  ).all<{ account_id: string }>();
  let alerts = 0;
  for (const row of accounts.results) {
    const result = await scoreHealthFromStoredMetrics(env, row.account_id) as any;
    const recent = await env.DB.prepare(
      `SELECT signal_type FROM commercial_signals
       WHERE account_id=? AND signal_type IN ('renewal_risk','expansion_ready')
       AND captured_at >= datetime('now','-30 days')`
    ).bind(row.account_id).all<{ signal_type: string }>();
    const types = new Set(recent.results.map((r) => r.signal_type));
    if (Number(result.renewalRisk || 0) >= 70 && !types.has("renewal_risk")) {
      await addSignal(env, {
        accountId: row.account_id,
        signalType: "renewal_risk",
        title: "Client health indicates elevated renewal risk",
        detail: "Review delivery, outcomes, engagement and outstanding decisions before the next renewal conversation.",
        confidence: Number(result.renewalRisk)
      });
      alerts += 1;
    }
    if (Number(result.expansionScore || 0) >= 75 && Number(result.healthScore || 0) >= 60 && !types.has("expansion_ready")) {
      await addSignal(env, {
        accountId: row.account_id,
        signalType: "expansion_ready",
        title: "Account may be ready for a value-led expansion review",
        detail: "Expansion should be proposed only where the additional service creates clear client value.",
        confidence: Number(result.expansionScore)
      });
      alerts += 1;
    }
  }
  return { refreshed: accounts.results.length, alerts };
}

export async function runDailyCommercialAutomation(env: Env): Promise<Record<string, unknown>> {
  const watchlists = await scanDueWatchlists(env, 5);
  const rescued = await rescueStaleOpportunities(env, 21, 10);
  const nurture = await processDueNurture(env, 15);
  const health = await refreshHealthAndExpansionSignals(env);
  const contentInsights = await harvestContentInsights(env, 30);
  const priorities = await nextBestAccounts(env, 10);

  let weekly: Record<string, unknown> | null = null;
  if (new Date().getUTCDay() === 1) {
    const benchmark = await generateBenchmark(env, { benchmarkType: "commercial_performance" });
    const insightCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM content_insights WHERE status='new'")
      .first<{ count: number }>();
    const content = env.AI && Number(insightCount?.count || 0) >= 5
      ? await generateContentAsset(env, { assetType: "newsletter", audience: "B2B commercial leaders", limit: 12 })
      : null;
    weekly = { benchmark, content };
  }

  return {
    watchlists,
    rescued,
    nurture,
    health,
    contentInsights,
    weekly,
    topPriorities: priorities.map((item) => ({
      accountId: item.accountId,
      name: item.name,
      score: item.score,
      suggestedAction: item.suggestedAction
    }))
  };
}

export async function commercialDashboard(env: Env): Promise<Record<string, unknown>> {
  const [accounts, opportunities, signals, watchlists, health, content, referrals, partners, outbound, subscriptions] = await Promise.all([
    env.DB.prepare("SELECT lifecycle_stage, COUNT(*) AS count FROM commercial_accounts WHERE status='active' GROUP BY lifecycle_stage").all<any>(),
    env.DB.prepare("SELECT stage, COUNT(*) AS count, COALESCE(SUM(value_estimate),0) AS value FROM opportunities GROUP BY stage").all<any>(),
    env.DB.prepare("SELECT signal_type, COUNT(*) AS count FROM commercial_signals WHERE captured_at >= datetime('now','-30 days') GROUP BY signal_type ORDER BY count DESC").all<any>(),
    env.DB.prepare("SELECT status, COUNT(*) AS count FROM watchlists GROUP BY status").all<any>(),
    env.DB.prepare("SELECT AVG(health_score) AS health, AVG(renewal_risk) AS renewal_risk, AVG(expansion_score) AS expansion FROM client_health").first<any>(),
    env.DB.prepare("SELECT status, COUNT(*) AS count FROM content_insights GROUP BY status").all<any>(),
    env.DB.prepare("SELECT status, COUNT(*) AS count, COALESCE(SUM(attributed_value),0) AS value FROM referrals GROUP BY status").all<any>(),
    env.DB.prepare("SELECT status, COUNT(*) AS count FROM partner_candidates GROUP BY status").all<any>(),
    env.DB.prepare("SELECT status, COUNT(*) AS count FROM outreach_candidates GROUP BY status").all<any>(),
    env.DB.prepare("SELECT product_code,status,COUNT(*) AS count FROM subscriptions GROUP BY product_code,status").all<any>()
  ]);
  return {
    accounts: accounts.results,
    opportunities: opportunities.results,
    recentSignals: signals.results,
    watchlists: watchlists.results,
    clientHealth: health || {},
    content: content.results,
    referrals: referrals.results,
    partners: partners.results,
    outbound: outbound.results,
    subscriptions: subscriptions.results
  };
}
