import type { Env } from "../types";
import { cfg } from "../config";
import { json, error, corsHeaders } from "../lib/http";
import { hashValue, verifyAdmin, verifyWebsiteSignature, timingSafeEqual } from "../lib/security";
import { id, isoNow } from "../lib/ids";
import { buildValuePreview, runDiagnostic } from "./diagnostics";
import type { DiagnosticAnswer, DiagnosticType } from "./types";
import {
  createWatchlist,
  discoverPartners,
  discoverTargetAccounts,
  nextBestAccounts,
  opportunityMap,
  scanWatchlist,
  buildReferralSuggestions
} from "./acquisition";
import {
  createOpportunityFromLead,
  enrollProblemNurture,
  followUpMeeting,
  generateCommercialDocument,
  nextBestMessage,
  prepareMeeting
} from "./convert";
import {
  expansionSuggestions,
  pricingIntelligence,
  recordObjection,
  recordOutcome,
  recordReferral,
  routeCommercialNeed,
  scoreClientHealth,
  recordAccountMetric
} from "./growth";
import {
  createExperiment,
  generateBenchmark,
  generateContentAsset,
  generateIndustryPlaybook,
  harvestContentInsights,
  qualitativeSearchDemand,
  recordExperimentResult
} from "./learn";
import { connectEntities, graphAround } from "./knowledge";
import { commercialDashboard, runDailyCommercialAutomation } from "./automation";
import { createApiClient, recordApiUsage, verifyApiClient } from "./apiClients";
import {
  createCampaignHypothesis,
  hypothesisPerformance,
  outreachQueue,
  recordCampaignEvent,
  stageAutonomousProspecting,
  updateOutreachCandidate,
  prepareOutreachContact,
  sendOutreachCandidate
} from "./outbound";
import {
  addPortfolioAccount,
  clientDashboard,
  createPortfolio,
  issuePortalToken,
  suggestPortfolioPriorities,
  verifyPortalToken
} from "./portal";
import {
  configureRoutingDestination,
  createSubscription,
  sendNewsletterAsset,
  subscribeNewsletter
} from "./subscriptions";

const DIAGNOSTICS = new Set<DiagnosticType>([
  "outbound_readiness", "icp_clarity", "competitor_positioning", "pipeline_gap",
  "account_coverage", "recruitment_bd", "channel_fit"
]);

function browserOrigin(request: Request, env: Env): boolean {
  return request.headers.get("origin") === cfg(env).publicOrigin;
}

async function parsedJson(request: Request, maxBytes = 100_000): Promise<any> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new Error("payload_too_large");
  return JSON.parse(raw);
}

async function signedOrAdmin(request: Request, env: Env): Promise<{ body: any; ok: boolean }> {
  const raw = await request.text();
  const ok = verifyAdmin(request, env) || await verifyWebsiteSignature(request, raw, env);
  if (!ok) return { body: null, ok: false };
  try { return { body: JSON.parse(raw), ok: true }; }
  catch { return { body: null, ok: false }; }
}

async function publicDiagnostic(request: Request, env: Env): Promise<Response> {
  if (!browserOrigin(request, env)) return error("Origin not allowed.", 403, "origin_rejected");
  const body = await parsedJson(request);
  if (!DIAGNOSTICS.has(body.type)) return error("Unknown diagnostic type.", 422);
  const answers = Array.isArray(body.answers) ? body.answers.slice(0, 30) as DiagnosticAnswer[] : [];
  const result = runDiagnostic(body.type as DiagnosticType, answers);
  const diagnosticId = id("diag");
  const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const tokenHash = await hashValue(token);
  await env.DB.prepare(
    `INSERT INTO diagnostics (
      diagnostic_id, diagnostic_type, visitor_id, lead_id, answers_json, score, result_json, public_token_hash, created_at
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`
  ).bind(
    diagnosticId,
    body.type,
    typeof body.visitorId === "string" ? body.visitorId.slice(0,128) : null,
    JSON.stringify(answers),
    result.score,
    JSON.stringify(result),
    tokenHash,
    isoNow()
  ).run();
  return json({ diagnosticId, token, result }, 201, corsHeaders(request.headers.get("origin"), cfg(env).publicOrigin));
}

async function getDiagnostic(request: Request, env: Env, diagnosticId: string): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token") || "";
  const row = await env.DB.prepare("SELECT * FROM diagnostics WHERE diagnostic_id=?").bind(diagnosticId).first<any>();
  if (!row?.public_token_hash) return error("Not found.", 404);
  if (!timingSafeEqual(await hashValue(token), row.public_token_hash)) return error("Unauthorized.", 401);
  return json({ diagnosticId, type: row.diagnostic_type, score: row.score, result: JSON.parse(row.result_json), createdAt: row.created_at });
}

function requireAdmin(request: Request, env: Env): Response | null {
  return verifyAdmin(request, env) ? null : error("Unauthorized.", 401, "unauthorized");
}

export async function routeCommercial(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/v1/value-preview" && request.method === "POST") {
    if (!browserOrigin(request, env)) return error("Origin not allowed.", 403);
    const body = await parsedJson(request, 20_000);
    return json(buildValuePreview({
      offer: typeof body.offer === "string" ? body.offer.slice(0,500) : "",
      market: typeof body.market === "string" ? body.market.slice(0,500) : "",
      problem: typeof body.problem === "string" ? body.problem.slice(0,500) : ""
    }), 200, corsHeaders(request.headers.get("origin"), cfg(env).publicOrigin));
  }

  if (path === "/v1/diagnostics" && request.method === "POST") return publicDiagnostic(request, env);
  const diagnostic = path.match(/^\/v1\/diagnostics\/([^/]+)$/);
  if (diagnostic && request.method === "GET") return getDiagnostic(request, env, diagnostic[1]!);

  if (path === "/v1/newsletter/subscribe" && request.method === "POST") {
    if (!browserOrigin(request, env)) return error("Origin not allowed.", 403);
    if (env.INTAKE_RATE_LIMITER) {
      const key = (request.headers.get("cf-connecting-ip") || "unknown").slice(0,80);
      const rate = await env.INTAKE_RATE_LIMITER.limit({ key: "newsletter:" + key });
      if (!rate.success) return error("Too many requests.", 429, "rate_limited");
    }
    const body = await parsedJson(request, 20_000);
    try {
      const subscriberId = await subscribeNewsletter(env, {
        email: String(body.email || ""),
        problemCategory: body.problemCategory ? String(body.problemCategory) : null,
        source: body.source ? String(body.source) : "website",
        consent: body.consent || {}
      });
      return json({ subscriberId, subscribed: true }, 201, corsHeaders(request.headers.get("origin"), cfg(env).publicOrigin));
    } catch (e) {
      return error(String(e).includes("consent") ? "Newsletter consent is required." : "Invalid subscription.", 422);
    }
  }

  if (path === "/v1/products" && request.method === "GET") {
    const rows = await env.DB.prepare("SELECT product_code,name,category,description,revenue_model,delivery_mode FROM commercial_products WHERE active=1 ORDER BY rowid").all();
    return json({ products: rows.results });
  }

  const clientPortal = path.match(/^\/v1\/client\/([^/]+)\/dashboard$/);
  if (clientPortal && request.method === "GET") {
    const token = url.searchParams.get("token") || "";
    if (!(await verifyPortalToken(env, clientPortal[1]!, token))) return error("Unauthorized.", 401);
    return json(await clientDashboard(env, clientPortal[1]!));
  }

  const industry = path.match(/^\/v1\/industries\/([^/]+)$/);
  if (industry && request.method === "GET") {
    const row = await env.DB.prepare("SELECT industry_slug,industry_name,playbook_json,generated_at FROM industry_playbooks WHERE industry_slug=? AND status='published'")
      .bind(industry[1]).first<any>();
    return row ? json({ ...row, playbook: JSON.parse(row.playbook_json) }) : error("Not found.", 404);
  }

  if (path === "/v1/watchlists" && request.method === "POST") {
    const auth = await signedOrAdmin(request, env);
    if (!auth.ok) return error("Unauthorized.", 401);
    const body = auth.body;
    if (!body?.subjectType || !body?.subjectValue) return error("Missing watchlist subject.", 422);
    const watchlistId = await createWatchlist(env, {
      ownerType: body.ownerType === "client" || body.ownerType === "prospect" ? body.ownerType : "clientmotive",
      ownerId: body.ownerId || null,
      subjectType: body.subjectType,
      subjectValue: String(body.subjectValue),
      signalTypes: Array.isArray(body.signalTypes) ? body.signalTypes : undefined,
      cadence: body.cadence,
      consent: body.consent || {}
    });
    return json({ watchlistId }, 201);
  }

  if (path === "/v1/api/diagnostic" && request.method === "POST") {
    const client = await verifyApiClient(env, request, "diagnostic");
    if (!client) return error("Unauthorized or quota exceeded.", 401);
    const body = await parsedJson(request);
    if (!DIAGNOSTICS.has(body.type)) return error("Unknown diagnostic type.", 422);
    const result = runDiagnostic(body.type, Array.isArray(body.answers) ? body.answers : []);
    await recordApiUsage(env, client.clientId, "diagnostic");
    return json({ result });
  }

  if (path === "/v1/api/accounts/discover" && request.method === "POST") {
    const client = await verifyApiClient(env, request, "account_discovery");
    if (!client) return error("Unauthorized or quota exceeded.", 401);
    const body = await parsedJson(request);
    if (!body.market || !body.offer) return error("market and offer are required.", 422);
    const accounts = await discoverTargetAccounts(env, { market: String(body.market), offer: String(body.offer), limit: Number(body.limit || 10) });
    await recordApiUsage(env, client.clientId, "account_discovery", Math.max(1, accounts.length));
    return json({ accounts });
  }

  if (path.startsWith("/v1/admin/")) {
    const unauthorized = requireAdmin(request, env);
    if (unauthorized) return unauthorized;
  }

  if (path === "/v1/admin/dashboard" && request.method === "GET") return json(await commercialDashboard(env));
  if (path === "/v1/admin/automation/run" && request.method === "POST") return json(await runDailyCommercialAutomation(env), 202);

  if (path === "/v1/admin/accounts/discover" && request.method === "POST") {
    const body = await parsedJson(request);
    return json({ accounts: await discoverTargetAccounts(env, { market: body.market, offer: body.offer, limit: body.limit }) }, 201);
  }
  if (path === "/v1/admin/partners/discover" && request.method === "POST") {
    const body = await parsedJson(request);
    return json({ partners: await discoverPartners(env, { market: body.market, complementaryTo: body.complementaryTo, limit: body.limit }) }, 201);
  }
  if (path === "/v1/admin/accounts/next-best" && request.method === "GET") return json({ accounts: await nextBestAccounts(env, Number(url.searchParams.get("limit") || "20")) });
  if (path === "/v1/admin/accounts/map" && request.method === "GET") return json({ accounts: await opportunityMap(env, Number(url.searchParams.get("limit") || "200")) });
  if (path === "/v1/admin/outbound/stage" && request.method === "POST") return json({ candidates: await stageAutonomousProspecting(env, await parsedJson(request)) }, 201);
  if (path === "/v1/admin/outbound/queue" && request.method === "GET") return json({ candidates: await outreachQueue(env, Number(url.searchParams.get("limit") || "50")) });
  const outboundPrepare = path.match(/^\/v1\/admin\/outbound\/([^/]+)\/prepare$/);
  if (outboundPrepare && request.method === "POST") {
    const body = await parsedJson(request);
    return json(await prepareOutreachContact(env,outboundPrepare[1]!,{
      personKey: body.personKey ? String(body.personKey) : null,
      enrich: body.enrich === true
    }));
  }
  const outboundSend = path.match(/^\/v1\/admin\/outbound\/([^/]+)\/send$/);
  if (outboundSend && request.method === "POST") return json(await sendOutreachCandidate(env,outboundSend[1]!));
  const outboundCandidate = path.match(/^\/v1\/admin\/outbound\/([^/]+)$/);
  if (outboundCandidate && request.method === "POST") {
    const body = await parsedJson(request);
    await updateOutreachCandidate(env, outboundCandidate[1]!, body.status);
    return json({ ok: true });
  }
  if (path === "/v1/admin/hypotheses" && request.method === "POST") return json({ hypothesisId: await createCampaignHypothesis(env, await parsedJson(request)) }, 201);
  if (path === "/v1/admin/hypothesis-events" && request.method === "POST") return json({ eventId: await recordCampaignEvent(env, await parsedJson(request)) }, 201);
  if (path === "/v1/admin/hypotheses/performance" && request.method === "GET") return json({ hypotheses: await hypothesisPerformance(env, Number(url.searchParams.get("limit") || "100")) });

  const message = path.match(/^\/v1\/admin\/accounts\/([^/]+)\/message$/);
  if (message && request.method === "POST") return json(await nextBestMessage(env, message[1]!));
  const referrals = path.match(/^\/v1\/admin\/accounts\/([^/]+)\/referrals$/);
  if (referrals && request.method === "GET") return json({ suggestions: await buildReferralSuggestions(env, referrals[1]!) });
  const health = path.match(/^\/v1\/admin\/accounts\/([^/]+)\/health$/);
  if (health && request.method === "POST") return json(await scoreClientHealth(env, health[1]!, await parsedJson(request)));
  const metric = path.match(/^\/v1\/admin\/accounts\/([^/]+)\/metrics$/);
  if (metric && request.method === "POST") return json({ metricId: await recordAccountMetric(env, metric[1]!, await parsedJson(request)) }, 201);
  const expansion = path.match(/^\/v1\/admin\/accounts\/([^/]+)\/expansion$/);
  if (expansion && request.method === "GET") return json(await expansionSuggestions(env, expansion[1]!));

  const scan = path.match(/^\/v1\/admin\/watchlists\/([^/]+)\/scan$/);
  if (scan && request.method === "POST") return json(await scanWatchlist(env, scan[1]!), 202);

  if (path === "/v1/admin/opportunities/from-lead" && request.method === "POST") {
    const body = await parsedJson(request);
    return json({ opportunityId: await createOpportunityFromLead(env, body.leadId) }, 201);
  }
  if (path === "/v1/admin/outcomes" && request.method === "POST") return json({ outcomeId: await recordOutcome(env, await parsedJson(request)) }, 201);
  if (path === "/v1/admin/objections" && request.method === "POST") return json({ objectionId: await recordObjection(env, await parsedJson(request)) }, 201);
  if (path === "/v1/admin/pricing" && request.method === "GET") return json(await pricingIntelligence(env, url.searchParams.get("segment")));

  if (path === "/v1/admin/documents" && request.method === "POST") return json(await generateCommercialDocument(env, await parsedJson(request)), 201);
  if (path === "/v1/admin/meetings" && request.method === "POST") return json(await prepareMeeting(env, await parsedJson(request)), 201);
  const followup = path.match(/^\/v1\/admin\/meetings\/([^/]+)\/follow-up$/);
  if (followup && request.method === "POST") return json(await followUpMeeting(env, followup[1]!, await parsedJson(request)));

  if (path === "/v1/admin/nurture" && request.method === "POST") return json({ enrollmentId: await enrollProblemNurture(env, await parsedJson(request)) }, 201);
  if (path === "/v1/admin/referrals" && request.method === "POST") {
    const body = await parsedJson(request);
    if (!body.referralCode) body.referralCode = "CM-" + crypto.randomUUID().slice(0,8).toUpperCase();
    return json({ referralId: await recordReferral(env, body), referralCode: body.referralCode }, 201);
  }
  if (path === "/v1/admin/routes/suggest" && request.method === "POST") return json(await routeCommercialNeed(env, await parsedJson(request)), 201);
  if (path === "/v1/admin/routing-destinations" && request.method === "POST") {
    await configureRoutingDestination(env, await parsedJson(request));
    return json({ ok: true }, 201);
  }
  if (path === "/v1/admin/subscriptions" && request.method === "POST") return json({ subscriptionId: await createSubscription(env, await parsedJson(request)) }, 201);
  if (path === "/v1/admin/relationships" && request.method === "POST") {
    const body = await parsedJson(request);
    await connectEntities(env, body.from, body.to, body.edgeType, body.evidence || [], Number(body.weight || 50));
    return json({ ok: true }, 201);
  }

  if (path === "/v1/admin/experiments" && request.method === "POST") return json({ experimentId: await createExperiment(env, await parsedJson(request)) }, 201);
  if (path === "/v1/admin/experiment-results" && request.method === "POST") return json({ resultId: await recordExperimentResult(env, await parsedJson(request)) }, 201);
  if (path === "/v1/admin/content/harvest" && request.method === "POST") return json({ created: await harvestContentInsights(env) }, 201);
  if (path === "/v1/admin/content/assets" && request.method === "POST") return json(await generateContentAsset(env, await parsedJson(request)), 201);
  const newsletterSend = path.match(/^\/v1\/admin\/newsletter\/([^/]+)\/send$/);
  if (newsletterSend && request.method === "POST") return json(await sendNewsletterAsset(env, newsletterSend[1]!), 202);
  if (path === "/v1/admin/search-demand" && request.method === "POST") return json(await qualitativeSearchDemand(env, await parsedJson(request)));
  if (path === "/v1/admin/industries/generate" && request.method === "POST") return json(await generateIndustryPlaybook(env, await parsedJson(request)), 201);
  const publishIndustry = path.match(/^\/v1\/admin\/industries\/([^/]+)\/publish$/);
  if (publishIndustry && request.method === "POST") {
    await env.DB.prepare("UPDATE industry_playbooks SET status='published',updated_at=? WHERE industry_slug=?").bind(isoNow(), publishIndustry[1]!).run();
    return json({ ok: true });
  }
  if (path === "/v1/admin/benchmarks" && request.method === "POST") return json(await generateBenchmark(env, await parsedJson(request)), 201);

  if (path === "/v1/admin/api-clients" && request.method === "POST") return json(await createApiClient(env, await parsedJson(request)), 201);
  if (path === "/v1/admin/portfolios" && request.method === "POST") return json({ portfolioId: await createPortfolio(env, await parsedJson(request)) }, 201);
  const portfolioAccount = path.match(/^\/v1\/admin\/portfolios\/([^/]+)\/accounts$/);
  if (portfolioAccount && request.method === "POST") {
    const body = await parsedJson(request);
    await addPortfolioAccount(env, { portfolioId: portfolioAccount[1]!, targetAccountId: body.targetAccountId, tier: body.tier, notes: body.notes });
    return json({ ok: true }, 201);
  }
  const portfolioPriorities = path.match(/^\/v1\/admin\/portfolios\/([^/]+)\/priorities$/);
  if (portfolioPriorities && request.method === "GET") return json({ accounts: await suggestPortfolioPriorities(env, portfolioPriorities[1]!, Number(url.searchParams.get("limit") || "10")) });
  const portalToken = path.match(/^\/v1\/admin\/accounts\/([^/]+)\/portal-token$/);
  if (portalToken && request.method === "POST") {
    const body = await parsedJson(request);
    return json(await issuePortalToken(env, portalToken[1]!, Number(body.expiresInDays || 90)), 201);
  }
  if (path === "/v1/admin/graph" && request.method === "GET") {
    const type = url.searchParams.get("type") || "";
    const key = url.searchParams.get("key") || "";
    if (!type || !key) return error("type and key are required.", 422);
    return json(await graphAround(env, type, key, Number(url.searchParams.get("limit") || "50")));
  }

  return null;
}
