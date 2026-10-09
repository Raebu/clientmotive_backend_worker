import type {
  BuyerRole,
  ChannelRecommendation,
  CompanyProfile,
  CompetitorAnalysis,
  Dossier,
  Env,
  EvidenceItem,
  ResearchMessage,
  ResearchStage,
  TargetAccount
} from "../types";
import type { LeadRow } from "../db";
import { audit, createResearchJob, getLead, markJob, setLeadResearchStatus } from "../db";
import { id, isoNow } from "../lib/ids";
import { aiJson, evidencePrompt } from "./ai";
import { discoverCompanyPages, searchMany } from "./search";
import { estimateBriefSpecificity, scoreLead } from "./scoring";
import { getIntentContext } from "./intent";
import { notifyLeadReady } from "./notifications";

const STAGES: ResearchStage[] = [
  "company_profile",
  "competitive_landscape",
  "market_channels",
  "buyers_icp",
  "target_accounts",
  "scoring",
  "dossier",
  "notify"
];

function nextStage(stage: ResearchStage): ResearchStage | null {
  const index = STAGES.indexOf(stage);
  return index >= 0 && index < STAGES.length - 1 ? STAGES[index + 1]! : null;
}

async function saveEvidence(env: Env, leadId: string, stage: string, evidence: EvidenceItem[]): Promise<void> {
  if (!evidence.length) return;
  const statements = evidence.slice(0, 80).map((item) =>
    env.DB.prepare(
      `INSERT INTO research_evidence (
        evidence_id, lead_id, stage, source_url, source_title, source_type,
        query_text, snippet, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id("evd"),
      leadId,
      stage,
      item.sourceUrl,
      item.title || null,
      item.sourceType,
      item.query || null,
      item.snippet.slice(0, 4000),
      item.capturedAt
    )
  );
  await env.DB.batch(statements);
}

async function companyProfileStage(env: Env, lead: LeadRow): Promise<void> {
  const pages = lead.domain ? await discoverCompanyPages(env, lead.domain) : [];
  const evidence: EvidenceItem[] = pages.map((page) => ({
    sourceUrl: page.url,
    title: page.title,
    snippet: page.text,
    sourceType: "website",
    capturedAt: isoNow()
  }));

  if (lead.company) {
    const searches = await searchMany(env, [
      `"${lead.company}" company ${lead.domain || ""}`,
      `"${lead.company}" customers services`,
      `"${lead.company}" news hiring expansion`
    ], 5);
    for (const group of searches) {
      for (const result of group.results) {
        evidence.push({
          sourceUrl: result.url,
          title: result.title,
          snippet: result.snippet,
          sourceType: "search",
          query: group.query,
          capturedAt: isoNow()
        });
      }
    }
  }
  await saveEvidence(env, lead.lead_id, "company_profile", evidence);

  const fallback: CompanyProfile = {
    companyName: lead.company,
    domain: lead.domain,
    summary: lead.offer,
    offers: [lead.offer],
    industries: [],
    geographies: [],
    buyerHints: [],
    proofPoints: [],
    risks: evidence.length ? [] : ["Limited public evidence was available."],
    sources: evidence.map((e) => e.sourceUrl).slice(0, 20)
  };
  const profile = await aiJson<CompanyProfile>(
    env,
    "You are a commercial research analyst. Build a conservative company profile from the prospect brief and supplied evidence.",
    `PROSPECT BRIEF\nCompany: ${lead.company}\nOffer: ${lead.offer}\nMarket: ${lead.market}\nProblem: ${lead.problem}\nOutcome: ${lead.outcome}\n\nEVIDENCE\n${evidencePrompt(evidence.map((e) => ({ title: e.title, url: e.sourceUrl, snippet: e.snippet })))}\n\nReturn: companyName, domain, summary, offers[], industries[], geographies[], buyerHints[], proofPoints[], risks[], sources[]. sources must only contain supplied URLs.`,
    fallback
  );

  await env.DB.prepare(
    `INSERT INTO company_profiles (
      lead_id, company_name, domain, summary, offers_json, industries_json,
      geographies_json, buyer_hints_json, proof_points_json, risks_json,
      sources_json, generated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(lead_id) DO UPDATE SET
      company_name=excluded.company_name, domain=excluded.domain, summary=excluded.summary,
      offers_json=excluded.offers_json, industries_json=excluded.industries_json,
      geographies_json=excluded.geographies_json, buyer_hints_json=excluded.buyer_hints_json,
      proof_points_json=excluded.proof_points_json, risks_json=excluded.risks_json,
      sources_json=excluded.sources_json, generated_at=excluded.generated_at`
  ).bind(
    lead.lead_id,
    profile.companyName || lead.company,
    profile.domain || lead.domain,
    profile.summary || lead.offer,
    JSON.stringify(profile.offers || []),
    JSON.stringify(profile.industries || []),
    JSON.stringify(profile.geographies || []),
    JSON.stringify(profile.buyerHints || []),
    JSON.stringify(profile.proofPoints || []),
    JSON.stringify(profile.risks || []),
    JSON.stringify(profile.sources || []),
    isoNow()
  ).run();
}

async function competitorStage(env: Env, lead: LeadRow): Promise<void> {
  const groups = await searchMany(env, [
    `${lead.offer} competitors alternatives ${lead.market}`,
    `${lead.problem} solutions providers ${lead.market}`,
    `"${lead.company}" competitors alternatives`
  ], 8);
  const evidence: EvidenceItem[] = [];
  for (const group of groups) {
    for (const result of group.results) {
      if (lead.domain && result.url.includes(lead.domain)) continue;
      evidence.push({
        sourceUrl: result.url,
        title: result.title,
        snippet: result.snippet,
        sourceType: "search",
        query: group.query,
        capturedAt: isoNow()
      });
    }
  }
  await saveEvidence(env, lead.lead_id, "competitive_landscape", evidence);
  const fallback: CompetitorAnalysis[] = [];
  const output = await aiJson<{ competitors: CompetitorAnalysis[] }>(
    env,
    "You are a competitive intelligence analyst. Only name a competitor when the evidence supports that the organisation exists and is relevant. Include status-quo alternatives where appropriate without inventing company names.",
    `BRIEF\nCompany: ${lead.company}\nOffer: ${lead.offer}\nMarket: ${lead.market}\nProblem: ${lead.problem}\n\nSEARCH EVIDENCE\n${evidencePrompt(evidence.map((e) => ({ title: e.title, url: e.sourceUrl, snippet: e.snippet })))}\n\nReturn {"competitors":[...]} with each item: name, website|null, competitorType direct|adjacent|status_quo|emerging, summary, positioning, strengths[], weaknesses[], differentiationOpportunity, sourceUrls[]. Keep at most 10. sourceUrls must be supplied URLs.`,
    { competitors: fallback }
  );
  await env.DB.prepare("DELETE FROM competitors WHERE lead_id = ?").bind(lead.lead_id).run();
  const rows = (output.competitors || []).slice(0, 10);
  if (rows.length) {
    await env.DB.batch(rows.map((item) => env.DB.prepare(
      `INSERT INTO competitors (
        competitor_id, lead_id, name, website, competitor_type, summary, positioning,
        strengths_json, weaknesses_json, differentiation_opportunity, source_urls_json, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id("comp"), lead.lead_id, item.name, item.website || null, item.competitorType,
      item.summary, item.positioning, JSON.stringify(item.strengths || []),
      JSON.stringify(item.weaknesses || []), item.differentiationOpportunity,
      JSON.stringify(item.sourceUrls || []), isoNow()
    )));
  }
}

async function channelStage(env: Env, lead: LeadRow): Promise<void> {
  const groups = await searchMany(env, [
    `${lead.market} where buyers discover vendors marketing channels`,
    `${lead.offer} marketing channels B2B`,
    `${lead.problem} industry publications associations communities`
  ], 6);
  const evidence: EvidenceItem[] = [];
  for (const group of groups) for (const result of group.results) evidence.push({
    sourceUrl: result.url,
    title: result.title,
    snippet: result.snippet,
    sourceType: "search",
    query: group.query,
    capturedAt: isoNow()
  });
  await saveEvidence(env, lead.lead_id, "market_channels", evidence);

  const fallback: ChannelRecommendation[] = [
    {
      channel: "Targeted outbound",
      priority: "high",
      role: "Create direct conversations with a finite, researchable buyer set.",
      why: "The prospect has explicitly requested B2B outreach support.",
      prerequisites: ["Clear ICP", "Verifiable reason for contact", "Human-reviewed messaging"],
      firstExperiment: "Build a small evidence-led account list and test one reason-for-contact hypothesis.",
      evidence: []
    }
  ];
  const output = await aiJson<{ channels: ChannelRecommendation[] }>(
    env,
    "You are a B2B go-to-market strategist. Rank channels from the actual buyer and offer context, not generic popularity. Distinguish demand capture, demand creation, direct outreach, partnerships and credibility channels.",
    `BRIEF\nOffer: ${lead.offer}\nMarket: ${lead.market}\nProblem: ${lead.problem}\nOutcome: ${lead.outcome}\n\nEVIDENCE\n${evidencePrompt(evidence.map((e) => ({ title: e.title, url: e.sourceUrl, snippet: e.snippet })))}\n\nReturn {"channels":[...]} where each item contains channel, priority high|medium|low, role, why, prerequisites[], firstExperiment, evidence[] (supplied URLs only). Include 5-8 channels and do not automatically rank LinkedIn first.`,
    { channels: fallback }
  );
  await env.DB.prepare("DELETE FROM channel_recommendations WHERE lead_id = ?").bind(lead.lead_id).run();
  const rows = (output.channels || []).slice(0, 8);
  if (rows.length) await env.DB.batch(rows.map((item) => env.DB.prepare(
    `INSERT INTO channel_recommendations (
      channel_id, lead_id, channel, priority, role_text, why_text, prerequisites_json,
      first_experiment, evidence_json, generated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id("channel"), lead.lead_id, item.channel, item.priority, item.role, item.why,
    JSON.stringify(item.prerequisites || []), item.firstExperiment,
    JSON.stringify(item.evidence || []), isoNow()
  )));
}

async function buyersStage(env: Env, lead: LeadRow): Promise<void> {
  const profile = await env.DB.prepare("SELECT * FROM company_profiles WHERE lead_id = ?").bind(lead.lead_id).first<any>();
  const competitorRows = await env.DB.prepare("SELECT name, summary, positioning FROM competitors WHERE lead_id = ? LIMIT 10")
    .bind(lead.lead_id).all<any>();
  const fallback: BuyerRole[] = [];
  const output = await aiJson<{ buyers: BuyerRole[] }>(
    env,
    "You are a B2B buying-committee analyst. Separate economic buyer, champion, user, influencer and blocker. Do not infer named people; use role/title families.",
    `BRIEF\nOffer: ${lead.offer}\nMarket: ${lead.market}\nProblem: ${lead.problem}\nOutcome: ${lead.outcome}\n\nCOMPANY PROFILE\n${JSON.stringify(profile || {})}\n\nCOMPETITIVE CONTEXT\n${JSON.stringify(competitorRows.results)}\n\nReturn {"buyers":[...]} with role, roleType economic_buyer|champion|user|influencer|blocker, pain, trigger, messageAngle, titleVariants[]. Keep 3-7 roles.`,
    { buyers: fallback }
  );
  await env.DB.prepare("DELETE FROM buyer_roles WHERE lead_id = ?").bind(lead.lead_id).run();
  const rows = (output.buyers || []).slice(0, 7);
  if (rows.length) await env.DB.batch(rows.map((item) => env.DB.prepare(
    `INSERT INTO buyer_roles (
      buyer_id, lead_id, role, role_type, pain, trigger_text, message_angle,
      title_variants_json, generated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id("buyer"), lead.lead_id, item.role, item.roleType, item.pain, item.trigger,
    item.messageAngle, JSON.stringify(item.titleVariants || []), isoNow()
  )));
}

async function targetAccountsStage(env: Env, lead: LeadRow): Promise<void> {
  const buyers = await env.DB.prepare("SELECT role, title_variants_json FROM buyer_roles WHERE lead_id = ?")
    .bind(lead.lead_id).all<any>();
  const groups = await searchMany(env, [
    `${lead.market} companies UK`,
    `${lead.market} companies hiring expansion`,
    `${lead.market} directory companies`
  ], 10);
  const evidence: EvidenceItem[] = [];
  for (const group of groups) for (const result of group.results) evidence.push({
    sourceUrl: result.url,
    title: result.title,
    snippet: result.snippet,
    sourceType: "search",
    query: group.query,
    capturedAt: isoNow()
  });
  await saveEvidence(env, lead.lead_id, "target_accounts", evidence);
  const output = await aiJson<{ accounts: TargetAccount[] }>(
    env,
    "You are an account research analyst. Only recommend named companies that appear in the supplied evidence. Never invent target accounts. Prefer relevance over list size.",
    `MARKET: ${lead.market}\nOFFER: ${lead.offer}\nBUYER ROLES: ${JSON.stringify(buyers.results)}\n\nSEARCH EVIDENCE\n${evidencePrompt(evidence.map((e) => ({ title: e.title, url: e.sourceUrl, snippet: e.snippet })))}\n\nReturn {"accounts":[...]} with company, website|null, rationale, triggers[], likelyBuyerRoles[], sourceUrls[]. Keep at most 20; every named account must have at least one source URL.`,
    { accounts: [] }
  );
  await env.DB.prepare("DELETE FROM target_accounts WHERE lead_id = ?").bind(lead.lead_id).run();
  const rows = (output.accounts || []).filter((a) => a.sourceUrls?.length).slice(0, 20);
  if (rows.length) await env.DB.batch(rows.map((item) => env.DB.prepare(
    `INSERT INTO target_accounts (
      account_id, lead_id, company, website, rationale, triggers_json,
      buyer_roles_json, source_urls_json, generated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id("account"), lead.lead_id, item.company, item.website || null, item.rationale,
    JSON.stringify(item.triggers || []), JSON.stringify(item.likelyBuyerRoles || []),
    JSON.stringify(item.sourceUrls || []), isoNow()
  )));
}

async function scoringStage(env: Env, lead: LeadRow): Promise<void> {
  const intent = lead.visitor_id ? await getIntentContext(env, lead.visitor_id) : null;
  const profile = await env.DB.prepare("SELECT * FROM company_profiles WHERE lead_id = ?").bind(lead.lead_id).first<any>();
  const buyers = await env.DB.prepare("SELECT COUNT(*) AS count FROM buyer_roles WHERE lead_id = ?").bind(lead.lead_id).first<{ count: number }>();
  const evidence = await env.DB.prepare("SELECT snippet FROM research_evidence WHERE lead_id = ? LIMIT 100").bind(lead.lead_id).all<{ snippet: string }>();

  const evidenceText = evidence.results.map((r) => r.snippet).join(" ").toLowerCase();
  const timingTerms = ["hiring", "expansion", "launched", "launch", "funding", "growth", "new market", "acquisition", "opening"];
  const timingHits = timingTerms.filter((term) => evidenceText.includes(term)).length;
  const specificity = estimateBriefSpecificity([lead.offer, lead.market, lead.problem, lead.outcome]);
  const problemSeverity = Math.min(100, 45 + Math.floor(lead.problem.length / 12));
  const companyFit = profile ? 70 : lead.domain ? 55 : 35;
  const commercialPotential = Math.min(90, 45 + Math.floor((lead.market.length + lead.outcome.length) / 20));
  const access = Math.min(95, 35 + Number(buyers?.count || 0) * 10);
  const timing = Math.min(90, 30 + timingHits * 12);
  const researchConfidence = Math.min(100, 20 + evidence.results.length * 3);

  const score = scoreLead({
    intentScore: intent?.intentScore || 25,
    hasBusinessDomain: Boolean(lead.domain),
    briefSpecificity: specificity,
    problemSeverity,
    timingSignals: timing,
    reachableBuyerConfidence: access,
    companyFitConfidence: companyFit,
    commercialValueConfidence: commercialPotential,
    researchConfidence
  });

  await env.DB.prepare(
    `INSERT INTO lead_scores (
      lead_id, fit, intent, need, timing, commercial_potential, access,
      overall, tier, reasons_json, scored_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(lead_id) DO UPDATE SET
      fit=excluded.fit, intent=excluded.intent, need=excluded.need, timing=excluded.timing,
      commercial_potential=excluded.commercial_potential, access=excluded.access,
      overall=excluded.overall, tier=excluded.tier, reasons_json=excluded.reasons_json,
      scored_at=excluded.scored_at`
  ).bind(
    lead.lead_id, score.fit, score.intent, score.need, score.timing,
    score.commercialPotential, score.access, score.overall, score.tier,
    JSON.stringify(score.reasons), isoNow()
  ).run();
}

async function dossierStage(env: Env, lead: LeadRow): Promise<void> {
  const [profile, competitors, channels, buyers, accounts, score] = await Promise.all([
    env.DB.prepare("SELECT * FROM company_profiles WHERE lead_id = ?").bind(lead.lead_id).first(),
    env.DB.prepare("SELECT * FROM competitors WHERE lead_id = ? LIMIT 10").bind(lead.lead_id).all(),
    env.DB.prepare("SELECT * FROM channel_recommendations WHERE lead_id = ?").bind(lead.lead_id).all(),
    env.DB.prepare("SELECT * FROM buyer_roles WHERE lead_id = ?").bind(lead.lead_id).all(),
    env.DB.prepare("SELECT * FROM target_accounts WHERE lead_id = ? LIMIT 20").bind(lead.lead_id).all(),
    env.DB.prepare("SELECT * FROM lead_scores WHERE lead_id = ?").bind(lead.lead_id).first()
  ]);

  const fallback: Dossier = {
    executiveSummary: `${lead.company} submitted a brief seeking ${lead.outcome}`,
    opportunityThesis: lead.problem,
    whatWeKnow: [lead.offer, lead.market],
    competitiveSummary: competitors.results.length ? "Competitor evidence has been collected for human review." : "Competitive evidence is limited.",
    channelSummary: channels.results.length ? "Channel recommendations have been generated from the brief and available evidence." : "Channel evidence is limited.",
    buyerSummary: buyers.results.length ? "Likely buying roles have been mapped." : "Buyer-role evidence is limited.",
    recommendedFirstMove: "Review the prospect brief and highest-confidence evidence before any outreach.",
    nextBestActions: [
      { action: "Human-review the evidence and opportunity thesis.", owner: "clientmotive", priority: "now", reason: "Research should be verified before external use." }
    ],
    prospectSnapshot: {
      headline: "We are reviewing the market, buyers and competitive context behind your brief.",
      observations: ["Your submitted context has been received and is being assessed."]
    }
  };

  const dossier = await aiJson<Dossier>(
    env,
    "You are ClientMotive's senior commercial strategist. Synthesize the structured research into a decision-ready opportunity dossier. Be concise, commercial and explicit about uncertainty. Never invent outcomes, client proof or facts.",
    `ORIGINAL BRIEF\n${JSON.stringify({
      company: lead.company, offer: lead.offer, market: lead.market, problem: lead.problem, outcome: lead.outcome
    })}\n\nCOMPANY PROFILE\n${JSON.stringify(profile || {})}\n\nCOMPETITORS\n${JSON.stringify(competitors.results)}\n\nCHANNELS\n${JSON.stringify(channels.results)}\n\nBUYERS\n${JSON.stringify(buyers.results)}\n\nTARGET ACCOUNTS\n${JSON.stringify(accounts.results)}\n\nSCORE\n${JSON.stringify(score || {})}\n\nReturn executiveSummary, opportunityThesis, whatWeKnow[], competitiveSummary, channelSummary, buyerSummary, recommendedFirstMove, nextBestActions[{action,owner clientmotive|prospect,priority now|next|later,reason}], prospectSnapshot{headline,observations[]}. The prospectSnapshot must be useful but must not expose internal scoring or unsupported conclusions.`,
    fallback,
    1800
  );

  await env.DB.prepare(
    `INSERT INTO dossiers (lead_id, dossier_json, prospect_snapshot_json, generated_at, version)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(lead_id) DO UPDATE SET
       dossier_json=excluded.dossier_json,
       prospect_snapshot_json=excluded.prospect_snapshot_json,
       generated_at=excluded.generated_at,
       version=dossiers.version+1`
  ).bind(
    lead.lead_id,
    JSON.stringify(dossier),
    JSON.stringify(dossier.prospectSnapshot || fallback.prospectSnapshot),
    isoNow()
  ).run();

  await env.DB.prepare("DELETE FROM next_actions WHERE lead_id = ? AND status = 'open'").bind(lead.lead_id).run();
  if (dossier.nextBestActions?.length) {
    await env.DB.batch(dossier.nextBestActions.slice(0, 10).map((action) =>
      env.DB.prepare(
        "INSERT INTO next_actions (action_id, lead_id, action_text, owner, priority, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)"
      ).bind(id("action"), lead.lead_id, action.action, action.owner, action.priority, action.reason, isoNow())
    ));
  }
}

async function notifyStage(env: Env, lead: LeadRow): Promise<void> {
  const scoreRow = await env.DB.prepare("SELECT * FROM lead_scores WHERE lead_id = ?").bind(lead.lead_id).first<any>();
  const dossierRow = await env.DB.prepare("SELECT dossier_json FROM dossiers WHERE lead_id = ?").bind(lead.lead_id).first<{ dossier_json: string }>();
  if (!scoreRow) return;
  const dossier = dossierRow ? JSON.parse(dossierRow.dossier_json) as Dossier : null;
  await notifyLeadReady(env, lead, {
    fit: scoreRow.fit,
    intent: scoreRow.intent,
    need: scoreRow.need,
    timing: scoreRow.timing,
    commercialPotential: scoreRow.commercial_potential,
    access: scoreRow.access,
    overall: scoreRow.overall,
    tier: scoreRow.tier,
    reasons: JSON.parse(scoreRow.reasons_json || "[]")
  }, dossier?.executiveSummary || "ClientMotive research is complete.");
}

export async function processResearchMessage(env: Env, message: ResearchMessage): Promise<void> {
  const lead = await getLead(env, message.leadId);
  if (!lead) throw new Error("lead_not_found");

  await markJob(env, message.jobId, "running");
  await setLeadResearchStatus(env, lead.lead_id, message.stage);
  try {
    switch (message.stage) {
      case "company_profile": await companyProfileStage(env, lead); break;
      case "competitive_landscape": await competitorStage(env, lead); break;
      case "market_channels": await channelStage(env, lead); break;
      case "buyers_icp": await buyersStage(env, lead); break;
      case "target_accounts": await targetAccountsStage(env, lead); break;
      case "scoring": await scoringStage(env, lead); break;
      case "dossier": await dossierStage(env, lead); break;
      case "notify": await notifyStage(env, lead); break;
      default: throw new Error("unknown_research_stage");
    }

    await markJob(env, message.jobId, "complete");
    await audit(env, lead.lead_id, "research-worker", "stage_complete", { stage: message.stage });

    const next = nextStage(message.stage);
    if (next) {
      const jobId = await createResearchJob(env, lead.lead_id, next);
      await env.RESEARCH_QUEUE.send({ jobId, leadId: lead.lead_id, stage: next });
    } else {
      await setLeadResearchStatus(env, lead.lead_id, "complete");
      await env.DB.prepare("UPDATE leads SET status = 'qualified', updated_at = ? WHERE lead_id = ?")
        .bind(isoNow(), lead.lead_id).run();
    }
  } catch (error) {
    const text = String(error).slice(0, 1000);
    await markJob(env, message.jobId, "failed", text);
    await setLeadResearchStatus(env, lead.lead_id, "error");
    await audit(env, lead.lead_id, "research-worker", "stage_failed", { stage: message.stage, error: text });
    throw error;
  }
}

export async function startResearch(env: Env, leadId: string): Promise<string> {
  const jobId = await createResearchJob(env, leadId, "company_profile");
  await env.RESEARCH_QUEUE.send({ jobId, leadId, stage: "company_profile" });
  await setLeadResearchStatus(env, leadId, "queued");
  return jobId;
}
