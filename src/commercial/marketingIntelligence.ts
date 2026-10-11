import type { Env } from "../types";
import { aiJson, evidencePrompt } from "../services/ai";
import { discoverCompanyPages, fetchPageBrandSignals, fetchPageText, searchMany } from "../services/search";
import { id, isoNow } from "../lib/ids";

type BrandSignals = Awaited<ReturnType<typeof fetchPageBrandSignals>>;

type CompetitorCandidate = {
  name: string;
  website: string | null;
  competitorType: "direct" | "adjacent" | "substitute" | "status_quo" | "emerging";
  whyRelevant: string;
  evidenceUrls: string[];
};

type DeepCompetitor = CompetitorCandidate & {
  domain: string | null;
  brandSignals: BrandSignals | null;
  pageEvidence: Array<{ title: string; url: string; text: string }>;
};

export type MarketingCompetitorReport = {
  executiveSummary: string;
  company: {
    brandStrategy: Record<string, unknown>;
    visualIdentity: Record<string, unknown>;
    verbalIdentity: Record<string, unknown>;
    positioning: Record<string, unknown>;
    audience: Record<string, unknown>;
    customerResearch: Record<string, unknown>;
    offerAndPricing: Record<string, unknown>;
    messagingArchitecture: Record<string, unknown>;
    websiteMarketing: Record<string, unknown>;
    seoAndContent: Record<string, unknown>;
    socialMedia: Record<string, unknown>;
    paidAdvertising: Record<string, unknown>;
    emailLifecycle: Record<string, unknown>;
    outboundAndAbm: Record<string, unknown>;
    productMarketingAndGtm: Record<string, unknown>;
    campaignsAndCreative: Record<string, unknown>;
    reputationPrEventsPartnerships: Record<string, unknown>;
    customerMarketing: Record<string, unknown>;
    conversionAndAnalytics: Record<string, unknown>;
    marketingOpsAndTech: Record<string, unknown>;
    aiGovernanceAndCompliance: Record<string, unknown>;
    internationalAndEmployerBrand: Record<string, unknown>;
    planningAndGovernance: Record<string, unknown>;
  };
  competitiveLandscape: {
    category: string | null;
    marketShape: string;
    directCompetitors: string[];
    indirectCompetitors: string[];
    substitutes: string[];
    statusQuoAlternatives: string[];
    comparisonDimensions: string[];
    crowdedPositions: string[];
    whiteSpace: string[];
  };
  competitorProfiles: Array<Record<string, unknown>>;
  opportunities: string[];
  risks: string[];
  priorities: Array<{ priority: string; why: string; nextStep: string }>;
  evidenceGaps: string[];
  confidence: number;
};

function clean(value: unknown, max = 700): string {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeList(value: unknown, max = 12, chars = 400): string[] {
  return Array.isArray(value) ? value.slice(0, max).map((v) => clean(v, chars)).filter(Boolean) : [];
}

function domainFromWebsite(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : "https://" + value);
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function dedupeEvidence(rows: Array<{ title?: string; url: string; snippet: string; query?: string }>) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (!row.url || seen.has(row.url)) return false;
    seen.add(row.url);
    return true;
  });
}

function fallbackReport(companyName: string, domain: string, brand: BrandSignals | null): MarketingCompetitorReport {
  return {
    executiveSummary: "Public evidence has been collected, but deeper analysis is required before making strong marketing or competitor claims.",
    company: {
      brandStrategy: { status: "insufficient_evidence" },
      visualIdentity: {
        status: brand ? "observed" : "insufficient_evidence",
        themeColor: brand?.themeColor || null,
        colours: brand?.colours || [],
        fonts: brand?.fonts || []
      },
      verbalIdentity: { status: "insufficient_evidence" },
      positioning: { status: "insufficient_evidence" },
      audience: { status: "insufficient_evidence" },
      customerResearch: { status: "requires_first_party_data" },
      offerAndPricing: { status: "insufficient_evidence" },
      messagingArchitecture: { status: "insufficient_evidence" },
      websiteMarketing: { status: "observed", domain },
      seoAndContent: { status: "insufficient_evidence" },
      socialMedia: { status: "insufficient_evidence" },
      paidAdvertising: { status: "requires_platform_or_ad_library_data" },
      emailLifecycle: { status: "requires_first_party_or_subscription_data" },
      outboundAndAbm: { status: "requires_first_party_data" },
      productMarketingAndGtm: { status: "insufficient_evidence" },
      campaignsAndCreative: { status: "insufficient_evidence" },
      reputationPrEventsPartnerships: { status: "insufficient_evidence" },
      customerMarketing: { status: "requires_first_party_data" },
      conversionAndAnalytics: { status: "requires_first_party_analytics" },
      marketingOpsAndTech: { status: "requires_first_party_or_technology_data" },
      aiGovernanceAndCompliance: { status: "insufficient_evidence" },
      internationalAndEmployerBrand: { status: "insufficient_evidence" },
      planningAndGovernance: { status: "requires_first_party_data" }
    },
    competitiveLandscape: {
      category: null,
      marketShape: "Insufficient evidence for a confident market-shape conclusion.",
      directCompetitors: [],
      indirectCompetitors: [],
      substitutes: [],
      statusQuoAlternatives: ["Do nothing / defer change"],
      comparisonDimensions: [],
      crowdedPositions: [],
      whiteSpace: []
    },
    competitorProfiles: [],
    opportunities: [],
    risks: ["Do not treat missing public evidence as proof that an activity does not exist."],
    priorities: [{ priority: "Validate the evidence", why: "Public evidence coverage is incomplete.", nextStep: "Review sources and add first-party commercial/marketing data where available." }],
    evidenceGaps: ["Customer research", "Campaign performance", "Conversion analytics", "CAC / ROAS / attribution", "Private pricing and pipeline data"],
    confidence: 30
  };
}

export async function buildMarketingCompetitorIntelligence(
  env: Env,
  input: { domain: string; companyName?: string | null; offer?: string | null; market?: string | null; leadId?: string | null }
): Promise<{ reportId: string; report: MarketingCompetitorReport; evidence: string[] }> {
  const domain = domainFromWebsite(input.domain);
  if (!domain) throw new Error("invalid_domain");

  const pages = await discoverCompanyPages(env, domain);
  const home = pages[0]?.url || "https://" + domain;
  let brandSignals: BrandSignals | null = null;
  try { brandSignals = await fetchPageBrandSignals(home); } catch {}

  const companyName = clean(input.companyName || pages[0]?.title || domain.split(".")[0], 140);
  const queryGroups = await searchMany(env, [
    `"${companyName}" competitors alternatives`,
    `"${companyName}" pricing products reviews customers`,
    `"${companyName}" marketing campaign advertising LinkedIn YouTube newsletter`,
    `"${companyName}" SEO content blog case studies webinar report`,
    `"${companyName}" partnership launch funding hiring acquisition leadership`,
    `"${companyName}" reviews complaints reputation`
  ], 7, "lead_research");

  const evidenceRows = dedupeEvidence(queryGroups.flatMap((group) =>
    group.results.map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.snippet,
      query: group.query
    }))
  )).slice(0, 45);

  const firstParty = pages.slice(0, 8).map((page) => ({
    title: page.title,
    url: page.url,
    snippet: page.text.slice(0, 5_000)
  }));

  let priorCompetitors: Array<{ name: string; website: string | null; competitor_type: string; source_urls_json: string }> = [];
  if (input.leadId) {
    try {
      const rows = await env.DB.prepare(
        "SELECT name,website,competitor_type,source_urls_json FROM competitors WHERE lead_id=? ORDER BY competitor_type,name LIMIT 10"
      ).bind(input.leadId).all<any>();
      priorCompetitors = rows.results || [];
    } catch {}
  }

  const candidateFallback: { competitors: CompetitorCandidate[] } = {
    competitors: priorCompetitors.map((row) => ({
      name: row.name,
      website: row.website,
      competitorType: (["direct","adjacent","emerging"].includes(row.competitor_type) ? row.competitor_type : "status_quo") as CompetitorCandidate["competitorType"],
      whyRelevant: "Previously identified in the ClientMotive competitive-landscape stage.",
      evidenceUrls: (() => { try { return JSON.parse(row.source_urls_json || "[]"); } catch { return []; } })()
    }))
  };

  const candidateOutput = await aiJson<{ competitors: CompetitorCandidate[] }>(
    env,
    "You are ClientMotive's evidence-led competitive intelligence analyst. Identify competitors and alternatives only when supplied evidence supports them. Never invent a named competitor. Distinguish direct, adjacent, substitute, emerging and status-quo alternatives.",
    [
      "COMPANY: " + companyName,
      "DOMAIN: " + domain,
      "OFFER CONTEXT: " + clean(input.offer, 1200),
      "MARKET CONTEXT: " + clean(input.market, 1200),
      "PRIOR COMPETITOR RECORDS: " + JSON.stringify(priorCompetitors),
      "",
      "EVIDENCE:",
      evidencePrompt([...firstParty, ...evidenceRows], 24_000),
      "",
      "Return {competitors:[...]} max 7. Each item: name, website|null, competitorType direct|adjacent|substitute|status_quo|emerging, whyRelevant, evidenceUrls[].",
      "Every named organisation must appear in supplied evidence or prior competitor records. Status-quo alternatives may be generic categories."
    ].join("\n"),
    candidateFallback,
    1300
  );

  const candidates = (candidateOutput.competitors || []).slice(0, 7);
  const deepCompetitors: DeepCompetitor[] = [];
  for (const candidate of candidates) {
    const competitorDomain = domainFromWebsite(candidate.website);
    let brand: BrandSignals | null = null;
    const pageEvidence: DeepCompetitor["pageEvidence"] = [];
    if (competitorDomain && competitorDomain !== domain) {
      try { brand = await fetchPageBrandSignals("https://" + competitorDomain); } catch {}
      for (const path of ["/", "/pricing", "/about", "/customers", "/case-studies"]) {
        try {
          const page = await fetchPageText("https://" + competitorDomain + path, 6_000);
          if (page && page.text.length > 120) pageEvidence.push(page);
        } catch {}
        if (pageEvidence.length >= 3) break;
      }
    }
    deepCompetitors.push({ ...candidate, domain: competitorDomain, brandSignals: brand, pageEvidence });
  }

  const competitorEvidence = deepCompetitors.map((c) => ({
    name: c.name,
    website: c.website,
    domain: c.domain,
    competitorType: c.competitorType,
    whyRelevant: c.whyRelevant,
    brandSignals: c.brandSignals,
    pages: c.pageEvidence.map((p) => ({ title: p.title, url: p.url, text: p.text.slice(0, 3_000) })),
    evidenceUrls: c.evidenceUrls
  }));

  const fallback = fallbackReport(companyName, domain, brandSignals);
  const report = await aiJson<MarketingCompetitorReport>(
    env,
    [
      "You are ClientMotive's senior marketing, brand and competitive-intelligence strategist.",
      "Build a decision-ready B2B marketing and competitor intelligence report from supplied public evidence.",
      "Never infer private performance metrics such as CAC, ROAS, conversion rate, pipeline attribution, NPS or revenue unless explicitly supplied.",
      "Never claim an ad campaign, email programme, customer relationship, market share, price or competitor fact without evidence.",
      "For unavailable first-party metrics, mark the field as requiring first-party data rather than guessing.",
      "Treat visual identity values extracted from HTML/CSS as observed signals, not official brand guidelines unless the evidence says so.",
      "Named competitors must come from the supplied competitor evidence.",
      "Separate facts, observations, hypotheses, gaps and recommendations."
    ].join(" "),
    [
      "SUBJECT COMPANY: " + companyName,
      "DOMAIN: " + domain,
      "OFFER CONTEXT: " + clean(input.offer, 1200),
      "MARKET CONTEXT: " + clean(input.market, 1200),
      "",
      "OBSERVED BRAND SIGNALS:",
      JSON.stringify(brandSignals),
      "",
      "FIRST-PARTY WEBSITE EVIDENCE:",
      evidencePrompt(firstParty, 16_000),
      "",
      "PUBLIC SEARCH EVIDENCE:",
      evidencePrompt(evidenceRows, 18_000),
      "",
      "DEEP COMPETITOR EVIDENCE:",
      JSON.stringify(competitorEvidence).slice(0, 22_000),
      "",
      "Return a JSON report with:",
      "executiveSummary;",
      "company containing brandStrategy, visualIdentity, verbalIdentity, positioning, audience, customerResearch, offerAndPricing, messagingArchitecture, websiteMarketing, seoAndContent, socialMedia, paidAdvertising, emailLifecycle, outboundAndAbm, productMarketingAndGtm, campaignsAndCreative, reputationPrEventsPartnerships, customerMarketing, conversionAndAnalytics, marketingOpsAndTech, aiGovernanceAndCompliance, internationalAndEmployerBrand, planningAndGovernance;",
      "competitiveLandscape {category,marketShape,directCompetitors[],indirectCompetitors[],substitutes[],statusQuoAlternatives[],comparisonDimensions[],crowdedPositions[],whiteSpace[]};",
      "competitorProfiles[] with name, domain, type, positioning, audience, messaging, visualIdentity, offers, pricingEvidence, proof, contentSeo, social, paidMedia, reputation, productAndCompanyMoves, strengths, weaknesses, audienceOverlap, exploitableGaps, threatLevel, confidence, evidenceUrls;",
      "opportunities[], risks[], priorities[{priority,why,nextStep}], evidenceGaps[], confidence 0-100.",
      "Each marketing section should cover what is evidenced, what is not known, and the most useful commercial implication."
    ].join("\n"),
    fallback,
    4_600
  );

  const reportId = id("mktintel");
  const evidenceUrls = [...new Set([...firstParty.map((x) => x.url), ...evidenceRows.map((x) => x.url)])].slice(0, 80);
  const coverage = evidenceUrls.length >= 15 ? "strong" : evidenceUrls.length >= 7 ? "moderate" : "limited";
  const confidence = Math.max(0, Math.min(100, Number(report.confidence || fallback.confidence)));

  await env.DB.prepare(
    `INSERT INTO marketing_intelligence_reports (
      report_id,lead_id,domain,company_name,report_json,evidence_json,evidence_coverage,confidence,status,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?, 'complete',?,?)`
  ).bind(
    reportId,
    input.leadId || null,
    domain,
    companyName || null,
    JSON.stringify(report),
    JSON.stringify(evidenceUrls),
    coverage,
    confidence,
    isoNow(),
    isoNow()
  ).run();

  const profiles = Array.isArray(report.competitorProfiles) ? report.competitorProfiles.slice(0, 10) : [];
  if (profiles.length) {
    await env.DB.batch(profiles.map((profile:any) => {
      const name = clean(profile?.name, 180) || "Unknown competitor";
      const pDomain = domainFromWebsite(clean(profile?.domain, 240)) || null;
      const matching = deepCompetitors.find((c) => clean(c.name,180).toLowerCase() === name.toLowerCase() || (pDomain && c.domain === pDomain));
      return env.DB.prepare(
        `INSERT INTO competitor_intelligence_profiles (
          profile_id,report_id,competitor_name,competitor_domain,competitor_type,profile_json,evidence_json,confidence,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        id("cintel"),
        reportId,
        name,
        pDomain,
        clean(profile?.type || matching?.competitorType || "adjacent", 40),
        JSON.stringify(profile),
        JSON.stringify(matching?.evidenceUrls || safeList(profile?.evidenceUrls, 20, 600)),
        Math.max(0, Math.min(100, Number(profile?.confidence || 40))),
        isoNow(),
        isoNow()
      );
    }));
  }

  return { reportId, report, evidence: evidenceUrls };
}

export async function latestMarketingCompetitorIntelligence(
  env: Env,
  input: { domain?: string | null; leadId?: string | null }
): Promise<{ reportId: string; domain: string; companyName: string | null; report: MarketingCompetitorReport; evidence: string[]; evidenceCoverage: string; confidence: number; createdAt: string } | null> {
  let row:any = null;
  if (input.leadId) {
    row = await env.DB.prepare(
      "SELECT * FROM marketing_intelligence_reports WHERE lead_id=? ORDER BY created_at DESC LIMIT 1"
    ).bind(input.leadId).first<any>();
  } else if (input.domain) {
    const domain = domainFromWebsite(input.domain);
    if (!domain) throw new Error("invalid_domain");
    row = await env.DB.prepare(
      "SELECT * FROM marketing_intelligence_reports WHERE domain=? ORDER BY created_at DESC LIMIT 1"
    ).bind(domain).first<any>();
  }
  if (!row) return null;
  return {
    reportId: row.report_id,
    domain: row.domain,
    companyName: row.company_name || null,
    report: JSON.parse(row.report_json),
    evidence: JSON.parse(row.evidence_json || "[]"),
    evidenceCoverage: row.evidence_coverage,
    confidence: Number(row.confidence || 0),
    createdAt: row.created_at
  };
}
