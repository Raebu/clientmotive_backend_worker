import type { Env, IntentContext, IntentEvent, VisitorStage } from "../types";
import { id, isoNow } from "../lib/ids";
import { upsertSession } from "../db";

const EVENT_WEIGHTS: Record<string, number> = {
  page_view: 1,
  services_view: 3,
  who_we_help_view: 3,
  industry_page_view: 4,
  approach_view: 4,
  results_view: 5,
  about_view: 1,
  contact_view: 7,
  cta_click: 4,
  return_visit: 4,
  brief_started: 10,
  brief_step_completed: 3,
  brief_reviewed: 6,
  brief_submitted: 25
};

function pathWeight(path: string): number {
  if (path.startsWith("/contact")) return 5;
  if (path.startsWith("/results")) return 4;
  if (path.startsWith("/approach")) return 3;
  if (path.startsWith("/services")) return 3;
  if (path.startsWith("/who-we-help")) return 3;
  return 0;
}

export function classifyIntent(rawScore: number, eventTypes: string[]): { score: number; stage: VisitorStage } {
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));
  if (eventTypes.includes("brief_submitted")) return { score: Math.max(95, score), stage: "submitted" };
  if (eventTypes.includes("brief_started")) return { score: Math.max(70, score), stage: "brief_started" };
  if (score >= 60) return { score, stage: "high_intent" };
  if (score >= 35) return { score, stage: "evaluating" };
  if (score >= 15) return { score, stage: "exploring" };
  return { score, stage: "discovering" };
}

export function ctaFor(stage: VisitorStage, lastPath = "/"): IntentContext["recommendedCta"] {
  switch (stage) {
    case "submitted":
      return { label: "See how we work", href: "/approach/", reason: "The growth brief is already submitted." };
    case "brief_started":
      return { label: "Continue your growth brief", href: "/contact/", reason: "The visitor has already started the brief." };
    case "high_intent":
      return { label: "Build your growth brief", href: "/contact/", reason: "Multiple evaluation signals indicate high buying intent." };
    case "evaluating":
      return lastPath.startsWith("/who-we-help")
        ? { label: "See how we would approach your market", href: "/approach/", reason: "Audience-specific interest is established." }
        : { label: "See how we measure the work", href: "/results/", reason: "Evaluation-stage visitors benefit from evidence and method." };
    case "exploring":
      return { label: "See who ClientMotive works with", href: "/who-we-help/", reason: "The visitor is exploring fit." };
    default:
      return { label: "Explore our approach", href: "/approach/", reason: "The visitor is still learning what ClientMotive does." };
  }
}

export async function recordIntentEvents(
  env: Env,
  events: IntentEvent[],
  cf?: { country?: unknown }
): Promise<void> {
  if (events.length === 0 || events.length > 25) throw new Error("invalid_event_batch");

  const statements: D1PreparedStatement[] = [];
  for (const event of events) {
    if (!event.visitorId || !event.sessionId || !event.eventType || !event.path) continue;
    await upsertSession(env, {
      visitorId: event.visitorId,
      sessionId: event.sessionId,
      path: event.path,
      referrerDomain: event.referrer ? (() => { try { return new URL(event.referrer).hostname; } catch { return null; } })() : null,
      countryCode: typeof cf?.country === "string" ? cf.country : null,
      deviceClass: null
    });

    const weight = (EVENT_WEIGHTS[event.eventType] || 0) + pathWeight(event.path);
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO visitor_events (
          event_id, visitor_id, session_id, event_type, path, properties_json,
          intent_weight, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        event.eventId || id("evt"),
        event.visitorId,
        event.sessionId,
        event.eventType,
        event.path,
        JSON.stringify(event.properties || {}),
        weight,
        event.occurredAt || isoNow()
      )
    );
  }
  if (statements.length) await env.DB.batch(statements);
}

export async function getIntentContext(env: Env, visitorId: string): Promise<IntentContext> {
  const events = await env.DB.prepare(
    `SELECT event_type, path, intent_weight, occurred_at
     FROM visitor_events
     WHERE visitor_id = ?
     ORDER BY occurred_at DESC
     LIMIT 80`
  ).bind(visitorId).all<{ event_type: string; path: string; intent_weight: number; occurred_at: string }>();

  const rows = events.results;
  const eventTypes = rows.map((row) => row.event_type);
  const total = rows.reduce((sum, row) => sum + Number(row.intent_weight || 0), 0);
  const distinctPaths = new Set(rows.map((row) => row.path)).size;
  const sessions = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM visitor_sessions WHERE visitor_id = ?"
  ).bind(visitorId).first<{ count: number }>();
  const returnBonus = Math.max(0, Number(sessions?.count || 0) - 1) * 4;
  const depthBonus = Math.min(12, distinctPaths * 2);
  const classified = classifyIntent(total + returnBonus + depthBonus, eventTypes);
  const lastPath = rows[0]?.path || "/";
  const strongest = [...rows]
    .sort((a, b) => b.intent_weight - a.intent_weight)
    .slice(0, 5)
    .map((row) => row.event_type + " on " + row.path);

  return {
    visitorId,
    intentScore: classified.score,
    stage: classified.stage,
    recommendedCta: ctaFor(classified.stage, lastPath),
    strongestSignals: [...new Set(strongest)]
  };
}
