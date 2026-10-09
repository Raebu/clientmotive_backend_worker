import type { Env, IntentEvent, LeadIntake } from "./types";
import { cfg } from "./config";
import { audit, createLead, getLead, getLeadBundle } from "./db";
import { corsHeaders, error, json } from "./lib/http";
import { hashValue, timingSafeEqual, verifyAdmin, verifyWebsiteSignature } from "./lib/security";
import { getIntentContext, recordIntentEvents } from "./services/intent";
import { startResearch } from "./services/research";

const ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validBrowserOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  return origin === cfg(env).publicOrigin;
}

function requestKey(request: Request): string {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  return ip.slice(0, 80);
}

async function rateLimit(request: Request, limiter: Env["EVENT_RATE_LIMITER"]): Promise<boolean> {
  if (!limiter) return true;
  return (await limiter.limit({ key: requestKey(request) })).success;
}

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function validateLead(body: LeadIntake): LeadIntake | null {
  const lead: LeadIntake = {
    idempotencyKey: clean(body.idempotencyKey, 160),
    visitorId: body.visitorId ? clean(body.visitorId, 128) : null,
    sessionId: body.sessionId ? clean(body.sessionId, 128) : null,
    name: clean(body.name, 100),
    email: clean(body.email, 160).toLowerCase(),
    company: clean(body.company, 140),
    website: body.website ? clean(body.website, 240) : null,
    offer: clean(body.offer, 1600),
    market: clean(body.market, 1600),
    problem: clean(body.problem, 1600),
    outcome: clean(body.outcome, 1600),
    sourcePath: body.sourcePath ? clean(body.sourcePath, 120) : null,
    source: body.source ? clean(body.source, 80) : "website",
    utm: body.utm || {},
    consent: body.consent || {}
  };
  if (
    lead.idempotencyKey.length < 8 ||
    lead.name.length < 2 ||
    !EMAIL_RE.test(lead.email) ||
    lead.company.length < 2 ||
    [lead.offer, lead.market, lead.problem, lead.outcome].some((part) => part.length < 10)
  ) return null;
  if (lead.visitorId && !ID_RE.test(lead.visitorId)) return null;
  if (lead.sessionId && !ID_RE.test(lead.sessionId)) return null;
  if (lead.website) {
    try {
      const u = new URL(lead.website.includes("://") ? lead.website : "https://" + lead.website);
      if (!["http:", "https:"].includes(u.protocol)) return null;
    } catch { return null; }
  }
  return lead;
}

async function publicEvents(request: Request, env: Env): Promise<Response> {
  if (!validBrowserOrigin(request, env)) return error("Origin not allowed.", 403, "origin_rejected");
  if (!(await rateLimit(request, env.EVENT_RATE_LIMITER))) return error("Too many events.", 429, "rate_limited");
  let parsed: { events?: IntentEvent[] };
  try { parsed = await request.json() as { events?: IntentEvent[] }; }
  catch { return error("Invalid JSON."); }
  const events = Array.isArray(parsed.events) ? parsed.events.slice(0, 25) : [];
  if (!events.length) return error("No events supplied.");
  for (const event of events) {
    if (!ID_RE.test(event.visitorId || "") || !ID_RE.test(event.sessionId || "")) return error("Invalid visitor/session identifier.");
    if (!event.path.startsWith("/") || event.path.length > 300) return error("Invalid path.");
    if (!/^[a-z0-9_:-]{2,60}$/i.test(event.eventType || "")) return error("Invalid event type.");
  }
  await recordIntentEvents(env, events, request.cf);
  return json({ ok: true, accepted: events.length }, 202, corsHeaders(request.headers.get("origin"), cfg(env).publicOrigin));
}

async function publicContext(request: Request, env: Env): Promise<Response> {
  if (!validBrowserOrigin(request, env)) return error("Origin not allowed.", 403, "origin_rejected");
  if (!(await rateLimit(request, env.EVENT_RATE_LIMITER))) return error("Too many requests.", 429, "rate_limited");
  const visitorId = new URL(request.url).searchParams.get("visitor_id") || "";
  if (!ID_RE.test(visitorId)) return error("Invalid visitor identifier.");
  const context = await getIntentContext(env, visitorId);
  return json(context, 200, corsHeaders(request.headers.get("origin"), cfg(env).publicOrigin));
}

async function leadIntake(request: Request, env: Env): Promise<Response> {
  if (!(await rateLimit(request, env.INTAKE_RATE_LIMITER))) return error("Too many submissions.", 429, "rate_limited");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 80_000) return error("Payload too large.", 413, "payload_too_large");

  const admin = verifyAdmin(request, env);
  const signed = await verifyWebsiteSignature(request, raw, env);
  if (!admin && !signed) return error("Invalid signature.", 401, "unauthorized");

  let body: LeadIntake;
  try { body = JSON.parse(raw) as LeadIntake; }
  catch { return error("Invalid JSON."); }
  const leadInput = validateLead(body);
  if (!leadInput) return error("Lead payload failed validation.", 422, "invalid_lead");

  const publicToken = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const publicTokenHash = await hashValue(publicToken);
  const { lead, created } = await createLead(env, leadInput, publicTokenHash);
  await audit(env, lead.lead_id, "website", created ? "lead_created" : "lead_replayed", {
    visitorId: leadInput.visitorId || null,
    source: leadInput.source || "website"
  });

  let researchJobId: string | null = null;
  if (created || lead.research_status === "error") {
    researchJobId = await startResearch(env, lead.lead_id);
  }

  return json({
    ok: true,
    leadId: lead.lead_id,
    created,
    researchJobId,
    prospectToken: publicToken,
    prospectSnapshotPath: `/v1/prospect/${lead.lead_id}/snapshot`
  }, created ? 201 : 200);
}

async function prospectSnapshot(request: Request, env: Env, leadId: string): Promise<Response> {
  if (!ID_RE.test(leadId)) return error("Invalid lead ID.");
  const token = new URL(request.url).searchParams.get("token") || "";
  if (token.length < 32 || token.length > 160) return error("Invalid token.", 401, "unauthorized");
  const lead = await getLead(env, leadId);
  if (!lead?.public_token_hash) return error("Not found.", 404, "not_found");
  const supplied = await hashValue(token);
  if (!timingSafeEqual(supplied, lead.public_token_hash)) return error("Invalid token.", 401, "unauthorized");

  const dossier = await env.DB.prepare("SELECT prospect_snapshot_json, generated_at FROM dossiers WHERE lead_id = ?")
    .bind(leadId).first<{ prospect_snapshot_json: string; generated_at: string }>();
  const profile = await env.DB.prepare("SELECT company_name, summary FROM company_profiles WHERE lead_id = ?")
    .bind(leadId).first<{ company_name: string; summary: string }>();

  return json({
    leadId,
    company: lead.company,
    researchStatus: lead.research_status,
    snapshot: dossier ? JSON.parse(dossier.prospect_snapshot_json) : null,
    companySummary: dossier ? profile?.summary || null : null,
    updatedAt: dossier?.generated_at || lead.updated_at
  });
}

async function adminLead(request: Request, env: Env, leadId: string): Promise<Response> {
  if (!verifyAdmin(request, env)) return error("Unauthorized.", 401, "unauthorized");
  try {
    return json(await getLeadBundle(env, leadId));
  } catch {
    return error("Lead not found.", 404, "not_found");
  }
}

async function adminResearch(request: Request, env: Env, leadId: string): Promise<Response> {
  if (!verifyAdmin(request, env)) return error("Unauthorized.", 401, "unauthorized");
  const lead = await getLead(env, leadId);
  if (!lead) return error("Lead not found.", 404, "not_found");
  const jobId = await startResearch(env, leadId);
  await audit(env, leadId, "admin-api", "research_requested", { jobId });
  return json({ ok: true, leadId, jobId }, 202);
}

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") {
    const origin = request.headers.get("origin");
    if (origin !== cfg(env).publicOrigin) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: corsHeaders(origin, cfg(env).publicOrigin) });
  }

  if (path === "/health" && request.method === "GET") {
    try {
      await env.DB.prepare("SELECT 1 AS ok").first();
      return json({
        ok: true,
        service: "clientmotive-backend-worker",
        environment: cfg(env).environment,
        search: env.TAVILY_API_KEY ? "tavily" : env.BRAVE_SEARCH_API_KEY ? "brave" : "disabled",
        ai: Boolean(env.AI)
      });
    } catch {
      return json({ ok: false, service: "clientmotive-backend-worker", database: false }, 503);
    }
  }

  if (path === "/v1/capabilities" && request.method === "GET") {
    return json({
      intent: true,
      adaptiveCta: true,
      leadIntake: true,
      asyncResearch: true,
      companyResearch: true,
      competitiveAnalysis: true,
      channelAnalysis: true,
      buyerMapping: true,
      targetAccountDiscovery: true,
      fitIntentNeedScoring: true,
      dossier: true,
      prospectSnapshot: true,
      searchProvider: env.TAVILY_API_KEY ? "tavily" : env.BRAVE_SEARCH_API_KEY ? "brave" : null,
      aiEnabled: Boolean(env.AI)
    });
  }

  if (path === "/v1/events" && request.method === "POST") return publicEvents(request, env);
  if (path === "/v1/context" && request.method === "GET") return publicContext(request, env);
  if (path === "/v1/leads/intake" && request.method === "POST") return leadIntake(request, env);

  const prospect = path.match(/^\/v1\/prospect\/([^/]+)\/snapshot$/);
  if (prospect && request.method === "GET") return prospectSnapshot(request, env, prospect[1]!);

  const lead = path.match(/^\/v1\/leads\/([^/]+)$/);
  if (lead && request.method === "GET") return adminLead(request, env, lead[1]!);

  const research = path.match(/^\/v1\/leads\/([^/]+)\/research$/);
  if (research && request.method === "POST") return adminResearch(request, env, research[1]!);

  return error("Not found.", 404, "not_found");
}
