import type { Env, IntentEvent, LeadIntake } from "./types";
import { cfg } from "./config";
import { audit, createLead, getLead, getLeadBundle } from "./db";
import { corsHeaders, error, json } from "./lib/http";
import { hashValue, timingSafeEqual, verifyAdmin, verifyWebsiteSignature } from "./lib/security";
import { getIntentContext, recordIntentEvents } from "./services/intent";
import { startResearch } from "./services/research";
import { routeCommercial } from "./commercial/router";
import { createOpportunityFromLead } from "./commercial/convert";
import { createWatchlist } from "./commercial/acquisition";
import { routeOps } from "./ops/router";
import { addPermission, upsertContact } from "./ops/crm";
import { seedAttributionFromVisitor } from "./ops/intelligence";

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
  await recordIntentEvents(env, events, { country: (request.cf as any)?.country });
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
  let opportunityId: string | null = null;
  if (created || lead.research_status === "error") {
    researchJobId = await startResearch(env, lead.lead_id);
  }
  if (created) {
    opportunityId = await createOpportunityFromLead(env, lead.lead_id);
    const account = await env.DB.prepare("SELECT account_id FROM commercial_accounts WHERE lead_id=? LIMIT 1").bind(lead.lead_id).first<{ account_id: string }>();
    const contactId = await upsertContact(env, {
      accountId: account?.account_id || null,
      leadId: lead.lead_id,
      fullName: lead.name,
      email: lead.email,
      source: "growth_brief",
      confidence: 100
    });
    await addPermission(env, {
      contactId,
      email: lead.email,
      channel: "email",
      purpose: "respond_to_enquiry",
      status: "allowed",
      source: "growth_brief",
      noticeVersion: leadInput.consent?.privacyNoticeVersion || null,
      metadata: { marketingConsent: leadInput.consent?.marketing === true }
    });
    if (leadInput.visitorId) {
      await seedAttributionFromVisitor(env, {
        visitorId: leadInput.visitorId,
        leadId: lead.lead_id,
        accountId: account?.account_id || null,
        opportunityId
      });
    }
    if (lead.domain) {
      await createWatchlist(env, {
        ownerType: "clientmotive",
        ownerId: lead.lead_id,
        subjectType: "account",
        subjectValue: lead.domain,
        signalTypes: ["hiring","buyer_change","expansion","launch","funding","partnership","m_and_a"],
        cadence: "weekly"
      });
    }
  }

  return json({
    ok: true,
    leadId: lead.lead_id,
    created,
    researchJobId,
    opportunityId,
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

  const [dossier, profile, competitors, buyers, channels, targets, actions] = await Promise.all([
    env.DB.prepare("SELECT prospect_snapshot_json, generated_at FROM dossiers WHERE lead_id = ?")
      .bind(leadId).first<{ prospect_snapshot_json: string; generated_at: string }>(),
    env.DB.prepare("SELECT company_name, summary FROM company_profiles WHERE lead_id = ?")
      .bind(leadId).first<{ company_name: string; summary: string }>(),
    env.DB.prepare(
      "SELECT name,website,competitor_type,summary,differentiation_opportunity FROM competitors WHERE lead_id=? ORDER BY competitor_type,name LIMIT 6"
    ).bind(leadId).all<any>(),
    env.DB.prepare(
      "SELECT role,role_type,pain,trigger_text,message_angle FROM buyer_roles WHERE lead_id=? ORDER BY role_type,role LIMIT 6"
    ).bind(leadId).all<any>(),
    env.DB.prepare(
      "SELECT channel,priority,role_text,why_text,first_experiment FROM channel_recommendations WHERE lead_id=? ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END LIMIT 6"
    ).bind(leadId).all<any>(),
    env.DB.prepare(
      "SELECT company,website,rationale,buyer_roles_json FROM target_accounts WHERE lead_id=? LIMIT 6"
    ).bind(leadId).all<any>(),
    env.DB.prepare(
      "SELECT action_text,owner,priority,reason FROM next_actions WHERE lead_id=? AND status='open' ORDER BY CASE priority WHEN 'now' THEN 1 WHEN 'next' THEN 2 ELSE 3 END LIMIT 8"
    ).bind(leadId).all<any>()
  ]);

  return json({
    leadId,
    company: lead.company,
    domain: lead.domain || null,
    researchStatus: lead.research_status,
    snapshot: dossier ? JSON.parse(dossier.prospect_snapshot_json) : null,
    companySummary: dossier ? profile?.summary || null : null,
    marketView: dossier ? {
      competitors: competitors.results,
      buyers: buyers.results,
      channels: channels.results,
      targetAccounts: targets.results.map((row:any)=>({
        company: row.company,
        website: row.website,
        rationale: row.rationale,
        buyerRoles: JSON.parse(row.buyer_roles_json || "[]")
      })),
      nextActions: actions.results
    } : null,
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
      valuePreview: true,
      diagnostics: true,
      productCatalogue: true,
      watchlists: true,
      triggerMonitoring: true,
      autonomousAccountDiscovery: true,
      partnerDiscovery: true,
      opportunityMaps: true,
      nextBestAccount: true,
      nextBestMessage: true,
      objections: true,
      winLoss: true,
      pricingIntelligence: true,
      scopeAndProposalDrafts: true,
      meetingPreparation: true,
      meetingFollowup: true,
      opportunityRescue: true,
      problemLedNurture: true,
      contentIntelligence: true,
      qualitativeSearchDemand: true,
      industryPlaybooks: true,
      benchmarkReports: true,
      referrals: true,
      clientHealth: true,
      renewalAndExpansion: true,
      experiments: true,
      crossBusinessRouting: true,
      knowledgeGraph: true,
      whiteLabelApi: true,
      unifiedCommercialInbox: true,
      contactBuyingCommittee: true,
      crmSyncAdapters: true,
      suppressionAndPermissions: true,
      deliverabilityIntelligence: true,
      enrichmentProvenance: true,
      contradictionDetection: true,
      revenueAttribution: true,
      revenueForecasting: true,
      revenueGapAutopilot: true,
      marginIntelligence: true,
      capacityAwareSelling: true,
      negativeIcp: true,
      lookalikeLearning: true,
      dealRisk: true,
      multiThreading: true,
      procurementIntelligence: true,
      tenderDiscovery: true,
      conversationIntelligence: true,
      voiceOfCustomer: true,
      competitiveBattlecards: true,
      offerPerformance: true,
      dynamicPackaging: true,
      billingIntegration: true,
      esignIntegration: true,
      onboarding: true,
      timeToValue: true,
      deliveryQuality: true,
      customerSuccessPlaybooks: true,
      churnLearning: true,
      revenueConcentration: true,
      partnerEconomics: true,
      partnerPortal: true,
      selfServiceOrders: true,
      creditsAndUsage: true,
      multiTenant: true,
      rbac: true,
      humanWorkQueue: true,
      provenanceAndConfidence: true,
      researchFreshness: true,
      aiEvaluation: true,
      workflowBudgets: true,
      modelRouting: true,
      failureDashboard: true,
      dataExport: true,
      decisionAudit: true,
      explainability: true,
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

  const commercial = await routeCommercial(request, env);
  if (commercial) return commercial;

  const ops = await routeOps(request, env);
  if (ops) return ops;

  return error("Not found.", 404, "not_found");
}
