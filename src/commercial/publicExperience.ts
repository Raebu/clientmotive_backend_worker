import type { Env } from "../types";
import { aiJson } from "../services/ai";
import { fetchPageText, searchWeb } from "../services/search";

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

function companyFromTitle(title: string, domain: string): string {
  const clean = decodeBasicEntities(title || "")
    .split(/\s+[|–—-]\s+/)[0]
    ?.replace(/\b(home|homepage|official site|official website)\b/gi, "")
    .trim();
  if (clean && clean.length >= 2 && clean.length <= 100) return clean;
  return domain.split(".")[0]!.replace(/[-_]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

type Preview = {
  domain: string;
  companyName: string;
  sourceUrl: string | null;
  brandMarkUrl: string;
  summary: string;
  likelyOffer: string;
  likelyMarket: string;
  buyerRoles: string[];
  commercialObservations: string[];
  comparisonCategories: string[];
  publicSignals: Array<{ title: string; snippet: string; url: string }>;
  evidenceNote: string;
};

export async function buildPublicCompanyPreview(env: Env, rawDomain: string): Promise<Preview> {
  const domain = normaliseDomain(rawDomain);
  let page = null;
  try { page = await fetchPageText("https://" + domain, 12_000); } catch {}
  if (!page) {
    try { page = await fetchPageText("https://www." + domain, 12_000); } catch {}
  }
  const companyName = companyFromTitle(page?.title || "", domain);
  let signalRows: Array<{ title: string; snippet: string; url: string }> = [];
  try {
    const search = await searchWeb(
      env,
      '"' + companyName + '" ' + domain + " hiring expansion partnership launch funding leadership",
      5,
      "public_preview"
    );
    signalRows = search
      .filter((item) => item.url)
      .slice(0, 5)
      .map((item) => ({ title: item.title || "Public signal", snippet: item.snippet || "", url: item.url }));
  } catch {}

  const fallback: Preview = {
    domain,
    companyName,
    sourceUrl: page?.url || null,
    brandMarkUrl: "https://www.google.com/s2/favicons?domain=" + encodeURIComponent(domain) + "&sz=128",
    summary: page?.text
      ? "ClientMotive found enough public website content to build a first-pass commercial view. The full Growth Snapshot adds deeper market, competitor, buyer and target-account research."
      : "ClientMotive can use this domain as the starting point for a deeper Growth Snapshot.",
    likelyOffer: page?.title || "Requires deeper research",
    likelyMarket: "Requires deeper research",
    buyerRoles: ["Economic buyer", "Operational owner", "Commercial champion"],
    commercialObservations: [
      "Use the public website to clarify the offer and market before choosing target accounts.",
      "Separate evidence from hypotheses before deciding who to contact.",
      signalRows.length ? "Recent public signals are available to test whether timing creates a reason to speak." : "A deeper research pass can look for timing signals beyond the company website."
    ],
    comparisonCategories: ["Direct alternatives", "Adjacent alternatives", "Status quo / do nothing"],
    publicSignals: signalRows,
    evidenceNote: "This is a first-pass analysis from public information. Buyer roles and comparison categories are hypotheses until validated."
  };

  if (!page?.text || page.text.length < 250) return fallback;

  const ai = await aiJson<{
    summary: string;
    likelyOffer: string;
    likelyMarket: string;
    buyerRoles: string[];
    commercialObservations: string[];
    comparisonCategories: string[];
  }>(
    env,
    "You are ClientMotive's public website analyst. Separate facts from hypotheses. Use only the supplied website evidence and public signal snippets. Do not name customers, competitors or outcomes unless the evidence explicitly supports them. Buyer roles and comparison categories must be phrased as hypotheses.",
    [
      "DOMAIN: " + domain,
      "COMPANY NAME CANDIDATE: " + companyName,
      "WEBSITE TITLE: " + page.title,
      "WEBSITE TEXT:",
      page.text.slice(0, 9_000),
      "",
      "PUBLIC SIGNALS:",
      JSON.stringify(signalRows.slice(0, 5)),
      "",
      "Return JSON with summary (max 55 words), likelyOffer (max 30 words), likelyMarket (max 30 words), buyerRoles (max 5 short role hypotheses), commercialObservations (max 4 concise evidence-led points), comparisonCategories (max 4 categories, not named companies)."
    ].join("\n"),
    {
      summary: fallback.summary,
      likelyOffer: fallback.likelyOffer,
      likelyMarket: fallback.likelyMarket,
      buyerRoles: fallback.buyerRoles,
      commercialObservations: fallback.commercialObservations,
      comparisonCategories: fallback.comparisonCategories
    },
    1000
  );

  return {
    ...fallback,
    summary: String(ai.summary || fallback.summary).slice(0, 700),
    likelyOffer: String(ai.likelyOffer || fallback.likelyOffer).slice(0, 300),
    likelyMarket: String(ai.likelyMarket || fallback.likelyMarket).slice(0, 300),
    buyerRoles: Array.isArray(ai.buyerRoles) ? ai.buyerRoles.slice(0, 5).map((x) => String(x).slice(0, 140)) : fallback.buyerRoles,
    commercialObservations: Array.isArray(ai.commercialObservations) ? ai.commercialObservations.slice(0, 4).map((x) => String(x).slice(0, 350)) : fallback.commercialObservations,
    comparisonCategories: Array.isArray(ai.comparisonCategories) ? ai.comparisonCategories.slice(0, 4).map((x) => String(x).slice(0, 160)) : fallback.comparisonCategories
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
