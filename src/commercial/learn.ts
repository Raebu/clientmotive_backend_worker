import type { Env } from "../types";
import { id, isoNow } from "../lib/ids";
import { aiJson } from "../services/ai";
import { searchMany } from "../services/search";

export async function createExperiment(
  env: Env,
  input: { name: string; dimension: string; hypothesis: string; variants: Record<string, unknown> }
): Promise<string> {
  const experimentId = id("exp");
  const now = isoNow();
  await env.DB.prepare(
    `INSERT INTO commercial_experiments (
      experiment_id, name, dimension, hypothesis, variant_json, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`
  ).bind(experimentId, input.name, input.dimension, input.hypothesis, JSON.stringify(input.variants), now, now).run();
  return experimentId;
}

export async function recordExperimentResult(
  env: Env,
  input: { experimentId: string; accountId?: string | null; opportunityId?: string | null; variant?: string | null; metric: string; numericValue?: number | null; outcome?: string | null; details?: Record<string, unknown> }
): Promise<string> {
  const resultId = id("expres");
  await env.DB.prepare(
    `INSERT INTO experiment_results (
      result_id, experiment_id, account_id, opportunity_id, variant, metric,
      numeric_value, outcome, details_json, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(resultId, input.experimentId, input.accountId || null, input.opportunityId || null, input.variant || null, input.metric, input.numericValue || null, input.outcome || null, JSON.stringify(input.details || {}), isoNow()).run();
  return resultId;
}

export async function harvestContentInsights(env: Env, limit = 50): Promise<number> {
  const [objections, signals] = await Promise.all([
    env.DB.prepare("SELECT * FROM objections ORDER BY created_at DESC LIMIT ?").bind(limit).all<any>(),
    env.DB.prepare("SELECT * FROM commercial_signals ORDER BY captured_at DESC LIMIT ?").bind(limit).all<any>()
  ]);
  let created = 0;
  const seen = new Set<string>();
  for (const objection of objections.results) {
    const key = "objection:" + objection.category + ":" + (objection.segment || "general");
    if (seen.has(key)) continue;
    seen.add(key);
    const exists = await env.DB.prepare("SELECT insight_id FROM content_insights WHERE source_type='objection' AND source_id=? LIMIT 1")
      .bind(objection.objection_id).first();
    if (exists) continue;
    await env.DB.prepare(
      `INSERT INTO content_insights (
        insight_id, source_type, source_id, audience, topic, problem, evidence_json,
        demand_type, priority, status, created_at
      ) VALUES (?, 'objection', ?, ?, ?, ?, ?, 'first_party', 80, 'new', ?)`
    ).bind(
      id("insight"), objection.objection_id, objection.segment || null,
      "How buyers think about " + objection.category,
      objection.objection_text,
      JSON.stringify([]),
      isoNow()
    ).run();
    created += 1;
  }
  for (const signal of signals.results.slice(0, 20)) {
    if (!signal.source_url) continue;
    const exists = await env.DB.prepare("SELECT insight_id FROM content_insights WHERE source_type='market_signal' AND source_id=? LIMIT 1")
      .bind(signal.signal_id).first();
    if (exists) continue;
    await env.DB.prepare(
      `INSERT INTO content_insights (
        insight_id, source_type, source_id, topic, problem, evidence_json,
        demand_type, priority, status, created_at
      ) VALUES (?, 'market_signal', ?, ?, ?, ?, 'qualitative', 55, 'new', ?)`
    ).bind(id("insight"), signal.signal_id, signal.title, signal.detail, JSON.stringify([signal.source_url]), isoNow()).run();
    created += 1;
  }
  return created;
}

export async function generateContentAsset(
  env: Env,
  input: { assetType: "article_brief" | "linkedin_post" | "newsletter" | "benchmark_outline"; audience?: string | null; limit?: number }
): Promise<{ assetId: string; draft: Record<string, unknown> }> {
  const insights = await env.DB.prepare(
    "SELECT * FROM content_insights WHERE status='new' ORDER BY priority DESC, created_at DESC LIMIT ?"
  ).bind(Math.max(1, Math.min(30, input.limit || 10))).all<any>();
  const fallback = {
    title: "Evidence-led commercial observations",
    audience: input.audience || "B2B commercial leaders",
    thesis: "Use real objections and market signals as editorial inputs rather than generic sales advice.",
    sections: insights.results.slice(0, 5).map((row) => ({ point: row.topic, evidence: JSON.parse(row.evidence_json || "[]") })),
    draft: "",
    requiresHumanReview: true
  };
  const draft = await aiJson<Record<string, unknown>>(
    env,
    "You create evidence-led ClientMotive editorial drafts. Never publish identifiable prospect information. Do not fabricate statistics or quote private form content. Convert patterns into useful general insights.",
    `ASSET TYPE: ${input.assetType}\nAUDIENCE: ${input.audience || "B2B commercial leaders"}\nANONYMISED/EDITORIAL INPUTS: ${JSON.stringify(insights.results.map((row) => ({
      sourceType: row.source_type, audience: row.audience, topic: row.topic, problem: row.problem, evidence: JSON.parse(row.evidence_json || "[]")
    })))}\nReturn title, thesis, sections[], draft, requiresHumanReview=true.`,
    fallback,
    1800
  );
  const assetId = id("asset");
  const now = isoNow();
  await env.DB.prepare(
    `INSERT INTO content_assets (
      asset_id, asset_type, audience, title, draft_json, status, source_insights_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)`
  ).bind(assetId, input.assetType, input.audience || null, String(draft.title || fallback.title), JSON.stringify(draft), JSON.stringify(insights.results.map((r) => r.insight_id)), now, now).run();
  return { assetId, draft };
}

export async function qualitativeSearchDemand(
  env: Env,
  input: { audience: string; problems: string[] }
): Promise<Record<string, unknown>> {
  const queries = input.problems.slice(0, 5).flatMap((problem) => [
    `${input.audience} ${problem}`,
    `how to ${problem} ${input.audience}`
  ]);
  const groups = await searchMany(env, queries, 5);
  return {
    demandType: "qualitative",
    note: "This identifies language and visible search-result competition; it does not claim keyword volume without a dedicated volume provider.",
    themes: groups.map((group) => ({
      query: group.query,
      resultCountObserved: group.results.length,
      titles: group.results.map((result) => result.title),
      sourceUrls: group.results.map((result) => result.url)
    }))
  };
}

export async function generateIndustryPlaybook(
  env: Env,
  input: { slug: string; industryName: string }
): Promise<Record<string, unknown>> {
  const groups = await searchMany(env, [
    `${input.industryName} buyers decision makers B2B`,
    `${input.industryName} market trends UK`,
    `${input.industryName} sales challenges procurement`,
    `${input.industryName} associations companies directory`
  ], 6);
  const evidence = groups.flatMap((group) => group.results.map((result) => ({ title: result.title, url: result.url, snippet: result.snippet })));
  const fallback = {
    industry: input.industryName,
    buyerRoles: [],
    triggers: [],
    commonOutreachMistakes: [],
    marketDynamics: [],
    diagnosticQuestions: [],
    sources: evidence.map((item) => item.url)
  };
  const playbook = await aiJson<Record<string, unknown>>(
    env,
    "You build evidence-led B2B industry playbooks for public landing pages. Avoid thin SEO copy. Never invent statistics. Sources must come from supplied evidence.",
    `INDUSTRY: ${input.industryName}\nEVIDENCE: ${JSON.stringify(evidence)}\nReturn industry, buyerRoles[], triggers[], commonOutreachMistakes[], marketDynamics[], diagnosticQuestions[], sources[].`,
    fallback,
    1800
  );
  const now = isoNow();
  await env.DB.prepare(
    `INSERT INTO industry_playbooks (industry_slug, industry_name, playbook_json, evidence_json, status, generated_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?)
     ON CONFLICT(industry_slug) DO UPDATE SET
       industry_name=excluded.industry_name, playbook_json=excluded.playbook_json,
       evidence_json=excluded.evidence_json, generated_at=excluded.generated_at,
       updated_at=excluded.updated_at`
  ).bind(input.slug, input.industryName, JSON.stringify(playbook), JSON.stringify(evidence), now, now).run();
  return playbook;
}

export async function generateBenchmark(
  env: Env,
  input: { benchmarkType: string; segment?: string | null }
): Promise<Record<string, unknown>> {
  const segmentClause = input.segment ? " AND a.segment = ?" : "";
  const binds: unknown[] = input.segment ? [input.segment] : [];
  const outcomes = await env.DB.prepare(
    `SELECT oo.outcome_type, oo.value, oo.reason, a.segment
     FROM opportunity_outcomes oo
     JOIN opportunities o ON o.opportunity_id=oo.opportunity_id
     JOIN commercial_accounts a ON a.account_id=o.account_id
     WHERE 1=1 ${segmentClause}
     ORDER BY oo.occurred_at DESC LIMIT 1000`
  ).bind(...binds).all<any>();
  const objections = await env.DB.prepare(
    `SELECT category, COUNT(*) AS count FROM objections
     WHERE 1=1 ${input.segment ? "AND segment = ?" : ""}
     GROUP BY category ORDER BY count DESC LIMIT 20`
  ).bind(...binds).all<any>();
  const won = outcomes.results.filter((r) => r.outcome_type === "won");
  const lost = outcomes.results.filter((r) => r.outcome_type === "lost");
  const report = {
    benchmarkType: input.benchmarkType,
    segment: input.segment || null,
    sampleSize: outcomes.results.length,
    wonCount: won.length,
    lostCount: lost.length,
    winRate: won.length + lost.length >= 5 ? Math.round((won.length / (won.length + lost.length)) * 1000) / 10 : null,
    topObjections: objections.results,
    publicationSafe: false,
    note: outcomes.results.length < 20
      ? "Sample is too small for a public benchmark; retain as internal directional intelligence."
      : "Human statistical/privacy review is required before publishing."
  };
  const benchmarkId = id("bench");
  await env.DB.prepare(
    "INSERT INTO benchmark_reports (benchmark_id, benchmark_type, segment, sample_size, report_json, status, generated_at) VALUES (?, ?, ?, ?, ?, 'draft', ?)"
  ).bind(benchmarkId, input.benchmarkType, input.segment || null, outcomes.results.length, JSON.stringify(report), isoNow()).run();
  return { benchmarkId, ...report };
}
