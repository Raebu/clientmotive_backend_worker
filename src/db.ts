import type { Env, LeadIntake } from "./types";
import { id, isoNow, normalizeDomain } from "./lib/ids";

export interface LeadRow {
  lead_id: string;
  visitor_id: string | null;
  session_id: string | null;
  name: string;
  email: string;
  email_domain: string | null;
  company: string;
  website: string | null;
  domain: string | null;
  offer: string;
  market: string;
  problem: string;
  outcome: string;
  source_path: string | null;
  source: string | null;
  status: string;
  research_status: string;
  created_at: string;
  updated_at: string;
}

export async function createLead(env: Env, intake: LeadIntake): Promise<{ lead: LeadRow; created: boolean }> {
  const existing = await env.DB.prepare(
    "SELECT * FROM leads WHERE idempotency_key = ? LIMIT 1"
  ).bind(intake.idempotencyKey).first<LeadRow>();
  if (existing) return { lead: existing, created: false };

  const leadId = id("lead");
  const now = isoNow();
  const domain = normalizeDomain(intake.website) || normalizeDomain(intake.email.split("@")[1]);
  const emailDomain = intake.email.includes("@") ? intake.email.split("@")[1]!.toLowerCase() : null;

  await env.DB.prepare(
    `INSERT INTO leads (
      lead_id, idempotency_key, visitor_id, session_id, name, email, email_domain,
      company, website, domain, offer, market, problem, outcome, source_path,
      source, utm_json, consent_json, status, research_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 'queued', ?, ?)`
  ).bind(
    leadId,
    intake.idempotencyKey,
    intake.visitorId || null,
    intake.sessionId || null,
    intake.name,
    intake.email.toLowerCase(),
    emailDomain,
    intake.company,
    intake.website || null,
    domain,
    intake.offer,
    intake.market,
    intake.problem,
    intake.outcome,
    intake.sourcePath || null,
    intake.source || "website",
    JSON.stringify(intake.utm || {}),
    JSON.stringify(intake.consent || {}),
    now,
    now
  ).run();

  if (intake.sessionId) {
    await env.DB.prepare(
      "UPDATE visitor_sessions SET submitted_lead_id = ?, last_seen_at = ? WHERE session_id = ?"
    ).bind(leadId, now, intake.sessionId).run();
  }

  const lead = await getLead(env, leadId);
  if (!lead) throw new Error("lead_create_failed");
  return { lead, created: true };
}

export async function getLead(env: Env, leadId: string): Promise<LeadRow | null> {
  return await env.DB.prepare("SELECT * FROM leads WHERE lead_id = ? LIMIT 1")
    .bind(leadId).first<LeadRow>();
}

export async function setLeadResearchStatus(env: Env, leadId: string, status: string): Promise<void> {
  await env.DB.prepare("UPDATE leads SET research_status = ?, updated_at = ? WHERE lead_id = ?")
    .bind(status, isoNow(), leadId).run();
}

export async function upsertSession(
  env: Env,
  input: {
    visitorId: string;
    sessionId: string;
    path: string;
    referrerDomain?: string | null;
    countryCode?: string | null;
    deviceClass?: string | null;
  }
): Promise<void> {
  const now = isoNow();
  await env.DB.prepare(
    `INSERT INTO visitor_sessions (
      session_id, visitor_id, started_at, last_seen_at, landing_path,
      referrer_domain, country_code, device_class, event_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(session_id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      event_count = visitor_sessions.event_count + 1`
  ).bind(
    input.sessionId,
    input.visitorId,
    now,
    now,
    input.path,
    input.referrerDomain || null,
    input.countryCode || null,
    input.deviceClass || null
  ).run();
}

export async function audit(env: Env, leadId: string | null, actor: string, action: string, details: unknown = {}): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_log (audit_id, lead_id, actor, action, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(id("audit"), leadId, actor, action, JSON.stringify(details), isoNow()).run();
}

export async function createResearchJob(env: Env, leadId: string, stage: string): Promise<string> {
  const existing = await env.DB.prepare(
    "SELECT job_id FROM research_jobs WHERE lead_id = ? AND stage = ? AND status IN ('queued','running','complete') LIMIT 1"
  ).bind(leadId, stage).first<{ job_id: string }>();
  if (existing) return existing.job_id;

  const jobId = id("job");
  const now = isoNow();
  await env.DB.prepare(
    "INSERT INTO research_jobs (job_id, lead_id, stage, status, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)"
  ).bind(jobId, leadId, stage, now, now).run();
  return jobId;
}

export async function markJob(
  env: Env,
  jobId: string,
  status: "running" | "complete" | "failed",
  error: string | null = null
): Promise<void> {
  const now = isoNow();
  await env.DB.prepare(
    `UPDATE research_jobs
     SET status = ?, error = ?, updated_at = ?,
         started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
         completed_at = CASE WHEN ? IN ('complete','failed') THEN ? ELSE completed_at END
     WHERE job_id = ?`
  ).bind(status, error, now, status, now, status, now, jobId).run();
}

export async function getLeadBundle(env: Env, leadId: string): Promise<Record<string, unknown>> {
  const lead = await getLead(env, leadId);
  if (!lead) throw new Error("lead_not_found");
  const [profile, score, dossier, competitors, buyers, channels, accounts] = await Promise.all([
    env.DB.prepare("SELECT * FROM company_profiles WHERE lead_id = ?").bind(leadId).first(),
    env.DB.prepare("SELECT * FROM lead_scores WHERE lead_id = ?").bind(leadId).first(),
    env.DB.prepare("SELECT * FROM dossiers WHERE lead_id = ?").bind(leadId).first(),
    env.DB.prepare("SELECT * FROM competitors WHERE lead_id = ? ORDER BY competitor_type, name").bind(leadId).all(),
    env.DB.prepare("SELECT * FROM buyer_roles WHERE lead_id = ? ORDER BY role_type, role").bind(leadId).all(),
    env.DB.prepare("SELECT * FROM channel_recommendations WHERE lead_id = ? ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END").bind(leadId).all(),
    env.DB.prepare("SELECT * FROM target_accounts WHERE lead_id = ? LIMIT 50").bind(leadId).all()
  ]);
  return {
    lead,
    profile,
    score,
    dossier,
    competitors: competitors.results,
    buyers: buyers.results,
    channels: channels.results,
    targetAccounts: accounts.results
  };
}
