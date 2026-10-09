import type { Env, SearchResult } from "../types";
import { cfg } from "../config";

async function takeSearchBudget(env: Env, workflow = "lead_research"): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      "SELECT budget_id,max_search_calls,spent_search_calls,resets_at FROM workflow_budgets WHERE tenant_id='tenant_clientmotive' AND workflow=? LIMIT 1"
    ).bind(workflow).first<any>();
    if (!row) return true;
    if (row.resets_at && new Date(row.resets_at).getTime() <= Date.now()) {
      const next = new Date(); next.setUTCMonth(next.getUTCMonth() + 1, 1); next.setUTCHours(0,0,0,0);
      await env.DB.prepare("UPDATE workflow_budgets SET spent_search_calls=0,spent_ai_calls=0,spent_cost=0,resets_at=?,updated_at=? WHERE budget_id=?")
        .bind(next.toISOString(), new Date().toISOString(), row.budget_id).run();
      row.spent_search_calls = 0;
    }
    if (row.max_search_calls !== null && Number(row.spent_search_calls || 0) >= Number(row.max_search_calls)) return false;
    await env.DB.prepare("UPDATE workflow_budgets SET spent_search_calls=spent_search_calls+1,updated_at=? WHERE budget_id=?")
      .bind(new Date().toISOString(), row.budget_id).run();
    return true;
  } catch {
    return true;
  }
}

function isUnsafeHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host === "0.0.0.0") return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const m = host.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd")) return true;
  return false;
}

export async function fetchPageText(url: string, maxChars = 24_000): Promise<{ title: string; text: string; url: string } | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(parsed.protocol) || isUnsafeHost(parsed.hostname)) return null;

  const response = await fetch(parsed.toString(), {
    headers: {
      "user-agent": "ClientMotiveResearchBot/1.0 (+https://www.clientmotive.com/)",
      accept: "text/html,application/xhtml+xml"
    },
    redirect: "follow",
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) return null;
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/html") && !type.includes("application/xhtml+xml")) return null;

  const raw = (await response.text()).slice(0, 800_000);
  const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  const text = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
  return { title, text, url: response.url };
}

async function tavilySearch(env: Env, query: string, maxResults: number): Promise<SearchResult[]> {
  if (!env.TAVILY_API_KEY) return [];
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: env.TAVILY_API_KEY,
      query,
      search_depth: "basic",
      max_results: maxResults,
      include_answer: false,
      include_raw_content: false
    }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error("tavily_search_failed:" + response.status);
  const data = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string; score?: number }> };
  return (data.results || [])
    .filter((r) => r.url)
    .map((r) => ({
      title: r.title || "",
      url: r.url!,
      snippet: (r.content || "").slice(0, 2_000),
      score: r.score
    }));
}

async function braveSearch(env: Env, query: string, maxResults: number): Promise<SearchResult[]> {
  if (!env.BRAVE_SEARCH_API_KEY) return [];
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(20, maxResults)));
  url.searchParams.set("safesearch", "moderate");
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "x-subscription-token": env.BRAVE_SEARCH_API_KEY
    },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error("brave_search_failed:" + response.status);
  const data = await response.json() as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return (data.web?.results || [])
    .filter((r) => r.url)
    .map((r) => ({
      title: r.title || "",
      url: r.url!,
      snippet: (r.description || "").slice(0, 2_000)
    }));
}

export async function searchWeb(env: Env, query: string, maxResults = 8, workflow = "lead_research"): Promise<SearchResult[]> {
  const provider = cfg(env).searchProvider;
  const available = (provider === "brave" && env.BRAVE_SEARCH_API_KEY) || env.TAVILY_API_KEY || env.BRAVE_SEARCH_API_KEY;
  if (!available) return [];
  if (!(await takeSearchBudget(env, workflow))) return [];
  if (provider === "brave" && env.BRAVE_SEARCH_API_KEY) return braveSearch(env, query, maxResults);
  if (env.TAVILY_API_KEY) return tavilySearch(env, query, maxResults);
  if (env.BRAVE_SEARCH_API_KEY) return braveSearch(env, query, maxResults);
  return [];
}

export async function searchMany(env: Env, queries: string[], maxResults = 6, workflow = "lead_research"): Promise<Array<{ query: string; results: SearchResult[] }>> {
  const max = cfg(env).maxSearchesPerLead;
  const unique = [...new Set(queries.map((q) => q.trim()).filter(Boolean))].slice(0, max);
  const output: Array<{ query: string; results: SearchResult[] }> = [];
  for (const query of unique) {
    try {
      output.push({ query, results: await searchWeb(env, query, maxResults, workflow) });
    } catch {
      output.push({ query, results: [] });
    }
  }
  return output;
}

export async function discoverCompanyPages(env: Env, domain: string): Promise<Array<{ title: string; text: string; url: string }>> {
  const maxPages = cfg(env).maxPagesPerCompany;
  const base = "https://" + domain;
  const priority = [
    "/",
    "/about",
    "/services",
    "/solutions",
    "/products",
    "/pricing",
    "/customers",
    "/case-studies"
  ];
  const urls = new Set<string>(priority.map((p) => new URL(p, base).toString()));

  try {
    const sitemap = await fetch(new URL("/sitemap.xml", base), {
      headers: { "user-agent": "ClientMotiveResearchBot/1.0 (+https://www.clientmotive.com/)" },
      signal: AbortSignal.timeout(6_000)
    });
    if (sitemap.ok) {
      const xml = (await sitemap.text()).slice(0, 400_000);
      for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/gi)) {
        const candidate = match[1]?.trim();
        if (!candidate) continue;
        try {
          const u = new URL(candidate);
          if (u.hostname.replace(/^www\./, "") !== domain) continue;
          if (/(about|service|solution|product|pricing|customer|case|industr|sector)/i.test(u.pathname)) {
            urls.add(u.toString());
          }
        } catch {}
        if (urls.size >= maxPages * 3) break;
      }
    }
  } catch {}

  const pages: Array<{ title: string; text: string; url: string }> = [];
  for (const url of [...urls].slice(0, maxPages * 2)) {
    if (pages.length >= maxPages) break;
    try {
      const page = await fetchPageText(url);
      if (page && page.text.length >= 150) pages.push(page);
    } catch {}
  }
  return pages;
}
