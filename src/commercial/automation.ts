import type { Env } from "../types";
import { scanDueWatchlists, nextBestAccounts } from "./acquisition";
import { rescueStaleOpportunities } from "./convert";
import { harvestContentInsights } from "./learn";

export async function runDailyCommercialAutomation(env: Env): Promise<Record<string, unknown>> {
  const watchlists = await scanDueWatchlists(env, 5);
  const rescued = await rescueStaleOpportunities(env, 21, 10);
  const contentInsights = await harvestContentInsights(env, 30);
  const priorities = await nextBestAccounts(env, 10);
  return {
    watchlists,
    rescued,
    contentInsights,
    topPriorities: priorities.map((item) => ({
      accountId: item.accountId,
      name: item.name,
      score: item.score,
      suggestedAction: item.suggestedAction
    }))
  };
}

export async function commercialDashboard(env: Env): Promise<Record<string, unknown>> {
  const [accounts, opportunities, signals, watchlists, health, content, referrals, partners] = await Promise.all([
    env.DB.prepare("SELECT lifecycle_stage, COUNT(*) AS count FROM commercial_accounts WHERE status='active' GROUP BY lifecycle_stage").all<any>(),
    env.DB.prepare("SELECT stage, COUNT(*) AS count, COALESCE(SUM(value_estimate),0) AS value FROM opportunities GROUP BY stage").all<any>(),
    env.DB.prepare("SELECT signal_type, COUNT(*) AS count FROM commercial_signals WHERE captured_at >= datetime('now','-30 days') GROUP BY signal_type ORDER BY count DESC").all<any>(),
    env.DB.prepare("SELECT status, COUNT(*) AS count FROM watchlists GROUP BY status").all<any>(),
    env.DB.prepare("SELECT AVG(health_score) AS health, AVG(renewal_risk) AS renewal_risk, AVG(expansion_score) AS expansion FROM client_health").first<any>(),
    env.DB.prepare("SELECT status, COUNT(*) AS count FROM content_insights GROUP BY status").all<any>(),
    env.DB.prepare("SELECT status, COUNT(*) AS count, COALESCE(SUM(attributed_value),0) AS value FROM referrals GROUP BY status").all<any>(),
    env.DB.prepare("SELECT status, COUNT(*) AS count FROM partner_candidates GROUP BY status").all<any>()
  ]);
  return {
    accounts: accounts.results,
    opportunities: opportunities.results,
    recentSignals: signals.results,
    watchlists: watchlists.results,
    clientHealth: health || {},
    content: content.results,
    referrals: referrals.results,
    partners: partners.results
  };
}
