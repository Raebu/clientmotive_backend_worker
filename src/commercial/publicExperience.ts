import type { Env } from "../types";
import { aiJson } from "../services/ai";
import { discoverCompanyPages, searchWeb } from "../services/search";

const DOMAIN_RE = /^(?=.{4,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function normaliseDomain(input: string): string {
  let value = String(input || "").trim().toLowerCase();
  if (!value) throw new Error("invalid_domain");
  try {
    if (value.includes("://")) value = new URL(value).hostname;
  } catch {
    throw new Error("invalid_domain");
  }
  value = value.replace(/^www\./, "").replace(/\.$/, "");
  if (!DOMAIN_RE.test(value)) throw new Error("invalid_domain");
  if (
    value === "localhost" ||
    value.endsWith(".local") ||
    /^127\./.test(value) ||
    /^10\./.test(value) ||
    /^192\.168\./.test(value) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(value)
  ) throw new Error("invalid_domain");
  return value;
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanPublicText(value: string, max = 360): string {
  const cleaned = decodeBasicEntities(String(value || ""))
    .replace(/#{1,6}\s*/g, " ")
    .replace(/\[\.\.\.\]/g, " ")
    .replace(/\s*\|\s*/g, " · ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= max) return cleaned;
  const sliced = cleaned.slice(0, max);
  const sentence = sliced.lastIndexOf(". ");
  return (sentence > Math.floor(max * 0.55) ? sliced.slice(0, sentence + 1) : sliced.replace(/\s+\S*$/, "") + "…").trim();
}

function companyFromTitle(title: string, domain: string): string {
  const clean = decodeBasicEntities(title || "")
    .split(/\s+[|–—-]\s+/)[0]
    ?.replace(/\b(home|homepage|official site|official website)\b/gi, "")
    .trim();
  if (clean && clean.length >= 2 && clean.length <= 100) return clean;
  return domain.split(".")[0]!.replace(/[-_]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function hostFor(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return ""; }
}

function normaliseEntity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function strongEntityMatch(url: string, title: string, snippet: string, domain: string, companyName: string): boolean {
  const host = hostFor(url);
  if (host === domain || host.endsWith("." + domain)) return true;

  const combined = (title + " " + snippet).toLowerCase();
  if (combined.includes(domain.toLowerCase())) return true;

  const entity = normaliseEntity(companyName);
  if (entity.length < 6) return false;
  return normaliseEntity(combined).includes(entity);
}

type PublicSignal = {
  headline: string;
  whyItMatters: string;
  url: string;
  source: string;
};

type EvidenceSource = {
  title: string;
  url: string;
  type: "website" | "public_signal";
};

type Preview = {
  domain: string;
  companyName: string;
  sourceUrl: string | null;
  brandMarkUrl: string;
  summary: string;
  likelyOffer: string | null;
  likelyMarket: string | null;
  buyerRoles: string[];
  commercialObservations: string[];
  commercialOpportunities: string[];
  comparisonCategories: string[];
  publicSignals: PublicSignal[];
  evidenceSources: EvidenceSource[];
  evidenceCoverage: "Strong" | "Moderate" | "Limited";
  sourceCount: number;
  evidenceNote: string;
};

export async function buildPublicCompanyPreview(env: Env, rawDomain: string): Promise<Preview> {
  const domain = normaliseDomain(rawDomain);

  let pages: Array<{ title: string; text: string; url: string }> = [];
  try { pages = await discoverCompanyPages(env, domain); } catch {}

  const primary = pages[0] || null;
  const companyName = companyFromTitle(primary?.title || "", domain);

  let matchedSignals: Array<{ title: string; snippet: string; url: string; source: string }> = [];
  try {
    const search = await searchWeb(
      env,
      '"' + domain + '" "' + companyName + '" (hiring OR expansion OR partnership OR launch OR funding OR leadership)',
      8,
      "public_preview"
    );

    matchedSignals = search
      .filter((item) => item.url && strongEntityMatch(item.url, item.title || "", item.snippet || "", domain, companyName))
      .map((item) => ({
        title: cleanPublicText(item.title || "Public signal", 180),
        snippet: cleanPublicText(item.snippet || "", 420),
        url: item.url,
        source: hostFor(item.url)
      }))
      .filter((item) => item.title && item.url)
      .filter((item, index, rows) => rows.findIndex((other) => other.url === item.url) === index)
      .slice(0, 3);
  } catch {}

  const firstPartyEvidence = pages.slice(0, 5).map((page) => ({
    title: cleanPublicText(page.title || companyName + " website", 180) || companyName + " website",
    url: page.url,
    type: "website" as const
  }));
  const signalEvidence = matchedSignals.map((row) => ({
    title: row.title,
    url: row.url,
    type: "public_signal" as const
  }));
  const evidenceSources: EvidenceSource[] = [...firstPartyEvidence, ...signalEvidence];

  const websiteEvidence = pages.slice(0, 5).map((page, index) => [
    "WEBSITE SOURCE " + (index + 1),
    "URL: " + page.url,
    "TITLE: " + page.title,
    "TEXT: " + page.text.slice(0, index === 0 ? 7_000 : 3_500)
  ].join("\n")).join("\n\n");

  const signalPrompt = matchedSignals.map((row, index) => ({
    sourceIndex: index,
    title: row.title,
    url: row.url,
    snippet: row.snippet
  }));

  const fallback = {
    summary: primary?.text
      ? "ClientMotive found public information for this company and can use it as the basis for a deeper commercial analysis."
      : "ClientMotive could not confidently read enough first-party information for a useful public preview.",
    likelyOffer: null as string | null,
    likelyMarket: null as string | null,
    buyerRoles: [] as string[],
    commercialObservations: primary?.text
      ? ["The company website provides enough first-party evidence to support a deeper commercial research pass."]
      : ["The public website did not provide enough reliable first-party evidence for a confident mini-report."],
    commercialOpportunities: [] as string[],
    comparisonCategories: [] as string[],
    signals: [] as Array<{ sourceIndex: number; headline: string; whyItMatters: string }>
  };

  const ai = pages.length
    ? await aiJson<{
        summary: string;
        likelyOffer: string | null;
        likelyMarket: string | null;
        buyerRoles: string[];
        commercialObservations: string[];
        commercialOpportunities: string[];
        comparisonCategories: string[];
        signals: Array<{ sourceIndex: number; headline: string; whyItMatters: string }>;
      }>(
        env,
        [
          "You are ClientMotive's customer-facing company analyst.",
          "Produce a concise commercial mini-report, not raw research.",
          "Use first-party website evidence as the primary source of truth.",
          "External signal rows have already passed deterministic entity matching, but only use a signal if the snippet itself clearly concerns this exact company.",
          "Never copy raw page text, navigation text, category strings, markdown fragments or search snippets into the answer.",
          "Never invent customers, competitors, outcomes, funding, hiring, leadership changes or buying intent.",
          "If evidence is insufficient for a field, return null or an empty array rather than filler such as 'requires deeper research'.",
          "Buyer roles, comparison categories and opportunities are hypotheses and must be phrased as such.",
          "Keep every item short, specific and useful to a B2B buyer."
        ].join(" "),
        [
          "DOMAIN: " + domain,
          "COMPANY NAME CANDIDATE: " + companyName,
          "",
          websiteEvidence || "NO FIRST-PARTY WEBSITE EVIDENCE",
          "",
          "STRICTLY MATCHED EXTERNAL SIGNAL CANDIDATES:",
          JSON.stringify(signalPrompt),
          "",
          "Return JSON with:",
          "- summary: max 45 words, plain English description of what the company appears to do",
          "- likelyOffer: max 22 words or null",
          "- likelyMarket: max 18 words or null",
          "- buyerRoles: max 4 short role hypotheses",
          "- commercialObservations: max 3 evidence-led observations",
          "- commercialOpportunities: max 3 useful opportunities/gaps to investigate, phrased as hypotheses",
          "- comparisonCategories: max 3 category-level alternatives/status-quo hypotheses, never invented named competitors",
          "- signals: max 3 objects with sourceIndex matching the supplied external signal candidate index, headline max 12 words, whyItMatters max 24 words"
        ].join("\n"),
        fallback,
        1200
      )
    : fallback;

  const publicSignals: PublicSignal[] = [];
  if (Array.isArray(ai.signals)) {
    for (const item of ai.signals.slice(0, 3)) {
      const index = Number(item?.sourceIndex);
      if (!Number.isInteger(index) || index < 0 || index >= matchedSignals.length) continue;
      const source = matchedSignals[index]!;
      const headline = cleanPublicText(String(item?.headline || ""), 160);
      const whyItMatters = cleanPublicText(String(item?.whyItMatters || ""), 260);
      if (!headline || !whyItMatters) continue;
      publicSignals.push({
        headline,
        whyItMatters,
        url: source.url,
        source: source.source
      });
    }
  }

  const firstPartyCount = firstPartyEvidence.length;
  const evidenceCoverage: "Strong" | "Moderate" | "Limited" =
    firstPartyCount >= 4 ? "Strong" :
    firstPartyCount >= 2 ? "Moderate" :
    "Limited";

  return {
    domain,
    companyName,
    sourceUrl: primary?.url || null,
    brandMarkUrl: "https://www.google.com/s2/favicons?domain_url=https%3A%2F%2F" + encodeURIComponent(domain) + "&sz=128",
    summary: cleanPublicText(String(ai.summary || fallback.summary), 620),
    likelyOffer: ai.likelyOffer ? cleanPublicText(String(ai.likelyOffer), 220) : null,
    likelyMarket: ai.likelyMarket ? cleanPublicText(String(ai.likelyMarket), 180) : null,
    buyerRoles: Array.isArray(ai.buyerRoles) ? ai.buyerRoles.slice(0, 4).map((x) => cleanPublicText(String(x), 130)).filter(Boolean) : [],
    commercialObservations: Array.isArray(ai.commercialObservations) ? ai.commercialObservations.slice(0, 3).map((x) => cleanPublicText(String(x), 300)).filter(Boolean) : [],
    commercialOpportunities: Array.isArray(ai.commercialOpportunities) ? ai.commercialOpportunities.slice(0, 3).map((x) => cleanPublicText(String(x), 300)).filter(Boolean) : [],
    comparisonCategories: Array.isArray(ai.comparisonCategories) ? ai.comparisonCategories.slice(0, 3).map((x) => cleanPublicText(String(x), 160)).filter(Boolean) : [],
    publicSignals,
    evidenceSources,
    evidenceCoverage,
    sourceCount: evidenceSources.length,
    evidenceNote: "First-pass public analysis. Buyer roles, comparison categories and opportunity ideas are hypotheses until validated."
  };
}

export async function publicExperienceMetrics(env: Env): Promise<Record<string, number>> {
  const names = ["company_profiles", "commercial_signals", "target_accounts", "buyer_roles"];
  const counts: Record<string, number> = {};
  for (const table of names) {
    try {
      const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM " + table).first<{ count: number }>();
      counts[table] = Number(row?.count || 0);
    } catch {
      counts[table] = 0;
    }
  }
  return {
    companiesResearched: counts.company_profiles || 0,
    signalsCaptured: counts.commercial_signals || 0,
    targetAccountsMapped: counts.target_accounts || 0,
    buyerRolesMapped: counts.buyer_roles || 0
  };
}
