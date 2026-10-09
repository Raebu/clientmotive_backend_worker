import type { Env } from "../types";
import { id, isoNow, normalizeDomain } from "../lib/ids";
import { aiJson, evidencePrompt } from "../services/ai";
import { searchMany, searchWeb } from "../services/search";
import { connectEntities, upsertKnowledgeNode } from "./knowledge";
import type { NextBestAccount } from "./types";

function nextCheck(cadence: string): string {
  const date = new Date();
  const days = cadence === "daily" ? 1 : cadence === "fortnightly" ? 14 : cadence === "monthly" ? 30 : 7;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

export async function ensureCommercialAccountFromLead(env: Env, leadId: string): Promise<string> {
  const lead = await env.DB.prepare("SELECT * FROM leads WHERE lead_id = ? LIMIT 1").bind(leadId).first<any>();
  if (!lead) throw new Error("lead_not_found");
  const existing = await env.DB.prepare(
    "SELECT account_id FROM commercial_accounts WHERE lead_id = ? OR (domain IS NOT NULL AND domain = ?) LIMIT 1"
  ).bind(leadId, lead.domain || "").first<{ account_id: string }>();
  const now = isoNow();
  if (existing) {
    await env.DB.prepare(
      "UPDATE commercial_accounts SET lead_id = COALESCE(lead_id, ?), name = ?, updated_at = ? WHERE account_id = ?"
    ).bind(leadId, lead.company, now, existing.account_id).run();
    return existing.account_id;
  }
  const accountId = id("acct");
  await env.DB.prepare(
    `INSERT INTO commercial_accounts (
      account_id, lead_id, name, domain, segment, lifecycle_stage, tier, status, source,
      metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'prospect', 2, 'active', 'inbound', '{}', ?, ?)`
  ).bind(accountId, leadId, lead.company, lead.domain || null, lead.market || null, now, now).run();
  await upsertKnowledgeNode(env, "company", lead.domain || accountId, lead.company, { accountId, leadId });
  return accountId;
}

export async function createAccount(
  env: Env,
  input: { name: string; website?: string | null; segment?: string | null; source?: string; tier?: number }
): Promise<string> {
  const domain = normalizeDomain(input.website);
  if (domain) {
    const existing = await env.DB.prepare("SELECT account_id FROM commercial_accounts WHERE domain = ? LIMIT 1")
      .bind(domain).first<{ account_id: string }>();
    if (existing) return existing.account_id;
  }
  const accountId = id("acct");
  const now = isoNow();
  await env.DB.prepare(
    `INSERT INTO commercial_accounts (
      account_id, name, domain, segment, lifecycle_stage, tier, status, source,
      metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'target', ?, 'active', ?, '{}', ?, ?)`
  ).bind(accountId, input.name.trim(), domain, input.segment || null, Math.max(1, Math.min(3, input.tier || 3)), input.source || "discovery", now, now).run();
  await upsertKnowledgeNode(env, "company", domain || accountId, input.name, { accountId });
  return accountId;
}

export async function addSignal(
  env: Env,
  input: {
    accountId?: string | null;
    signalType: string;
    title: string;
    detail: string;
    sourceUrl?: string | null;
    confidence?: number;
    occurredAt?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<string> {
  const signalId = id("sig");
  await env.DB.prepare(
    `INSERT INTO commercial_signals (
      signal_id, account_id, signal_type, title, detail, source_url, confidence,
      occurred_at, captured_at, status, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`
  ).bind(
    signalId,
    input.accountId || null,
    input.signalType,
    input.title.slice(0, 220),
    input.detail.slice(0, 4000),
    input.sourceUrl || null,
    Math.max(0, Math.min(100, input.confidence || 50)),
    input.occurredAt || null,
    isoNow(),
    JSON.stringify(input.metadata || {})
  ).run();
  return signalId;
}

export async function createWatchlist(
  env: Env,
  input: {
    ownerType: "clientmotive" | "client" | "prospect";
    ownerId?: string | null;
    subjectType: "account" | "competitor" | "buyer_role" | "market" | "partner";
    subjectValue: string;
    signalTypes?: string[];
    cadence?: "daily" | "weekly" | "fortnightly" | "monthly";
    consent?: Record<string, unknown>;
  }
): Promise<string> {
  const watchlistId = id("watch");
  const now = isoNow();
  await env.DB.prepare(
    `INSERT INTO watchlists (
      watchlist_id, owner_type, owner_id, subject_type, subject_value, signal_types_json,
      cadence, next_check_at, status, consent_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
  ).bind(
    watchlistId,
    input.ownerType,
    input.ownerId || null,
    input.subjectType,
    input.subjectValue.slice(0, 300),
    JSON.stringify(input.signalTypes || ["hiring", "leadership", "expansion", "launch", "funding", "partnership"]),
    input.cadence || "weekly",
    now,
    JSON.stringify(input.consent || {}),
    now,
    now
  ).run();
  return watchlistId;
}

function signalTypeFor(text: string): string {
  const value = text.toLowerCase();
  if (/appoint|joins|joined|hired|new (chief|head|director|vp)/.test(value)) return "buyer_change";
  if (/hiring|vacanc|jobs|recruit/.test(value)) return "hiring";
  if (/funding|raised|investment|series [a-z]/.test(value)) return "funding";
  if (/launch|new product|new service/.test(value)) return "launch";
  if (/expand|new office|new market|international/.test(value)) return "expansion";
  if (/partner|partnership|alliance/.test(value)) return "partnership";
  if (/acqui|merger/.test(value)) return "m_and_a";
  return "market_change";
}

export async function scanWatchlist(env: Env, watchlistId: string): Promise<{ found: number; signalIds: string[] }> {
  const watch = await env.DB.prepare("SELECT * FROM watchlists WHERE watchlist_id = ? LIMIT 1")
    .bind(watchlistId).first<any>();
  if (!watch || watch.status !== "active") return { found: 0, signalIds: [] };
  const requested = JSON.parse(watch.signal_types_json || "[]") as string[];
  const query = [watch.subject_value, ...requested.slice(0, 5)].join(" ");
  const results = await searchWeb(env, query, 8);
  let found = 0;
  const signalIds: string[] = [];

  for (const result of results) {
    const type = signalTypeFor(result.title + " " + result.snippet);
    const duplicate = await env.DB.prepare(
      "SELECT signal_id FROM commercial_signals WHERE source_url = ? AND signal_type = ? LIMIT 1"
    ).bind(result.url, type).first();
    if (duplicate) continue;

    let accountId: string | null = null;
    if (watch.subject_type === "account" || watch.subject_type === "competitor") {
      const domain = normalizeDomain(watch.subject_value);
      if (domain) {
        const account = await env.DB.prepare("SELECT account_id FROM commercial_accounts WHERE domain = ? LIMIT 1")
          .bind(domain).first<{ account_id: string }>();
        accountId = account?.account_id || null;
      }
    }
    const signalId = await addSignal(env, {
      accountId,
      signalType: type,
      title: result.title || watch.subject_value,
      detail: result.snippet,
      sourceUrl: result.url,
      confidence: typeof result.score === "number" ? Math.round(result.score * 100) : 60,
      metadata: { watchlistId, subjectType: watch.subject_type }
    });
    signalIds.push(signalId);
    found += 1;
  }

  await env.DB.prepare(
    "UPDATE watchlists SET last_checked_at = ?, next_check_at = ?, updated_at = ? WHERE watchlist_id = ?"
  ).bind(isoNow(), nextCheck(watch.cadence), isoNow(), watchlistId).run();

  if (signalIds.length && watch.owner_type === "prospect" && watch.owner_id) {
    const consent = JSON.parse(watch.consent_json || "{}") as Record<string, unknown>;
    if (consent.accountWatch === true && env.RESEND_API_KEY) {
      const lead = await env.DB.prepare("SELECT email,name FROM leads WHERE lead_id=? LIMIT 1")
        .bind(watch.owner_id).first<{ email: string; name: string }>();
      if (lead?.email) {
        const rows = await env.DB.prepare(
          `SELECT title,detail,source_url FROM commercial_signals
           WHERE signal_id IN (${signalIds.map(() => "?").join(",")})`
        ).bind(...signalIds).all<any>();
        const text = [
          "ClientMotive account watch",
          "",
          "We found new public information related to: " + watch.subject_value,
          "",
          ...rows.results.flatMap((row) => [
            row.title,
            row.detail,
            row.source_url || "",
            ""
          ]),
          "You are receiving this because you opted into this account watch."
        ].join("\n");
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: "Bearer " + env.RESEND_API_KEY,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            from: env.ALERT_EMAIL_FROM || "ClientMotive Signals <clientmotive@theraeburngroup.com>",
            to: [lead.email],
            subject: "New signal from your ClientMotive account watch",
            text
          })
        });
        await env.DB.prepare(
          "INSERT INTO watch_notifications (notification_id,watchlist_id,recipient,signal_ids_json,status,provider_id,error,sent_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)"
        ).bind(
          id("wnote"), watchlistId, lead.email, JSON.stringify(signalIds),
          response.ok ? "sent" : "failed", null,
          response.ok ? null : "resend_" + response.status,
          response.ok ? isoNow() : null,
          isoNow()
        ).run();
      }
    }
  }
  return { found, signalIds };
}

export async function scanDueWatchlists(env: Env, limit = 5): Promise<{ scanned: number; signals: number }> {
  const due = await env.DB.prepare(
    "SELECT watchlist_id FROM watchlists WHERE status = 'active' AND next_check_at <= ? ORDER BY next_check_at LIMIT ?"
  ).bind(isoNow(), Math.max(1, Math.min(20, limit))).all<{ watchlist_id: string }>();
  let signals = 0;
  for (const row of due.results) signals += (await scanWatchlist(env, row.watchlist_id)).found;
  return { scanned: due.results.length, signals };
}

export async function discoverTargetAccounts(
  env: Env,
  input: { market: string; offer: string; limit?: number }
): Promise<Array<{ accountId: string; company: string; website: string | null; rationale: string }>> {
  const groups = await searchMany(env, [
    `${input.market} companies directory`,
    `${input.market} companies growth hiring`,
    `${input.market} businesses UK`
  ], 10);
  const evidence = groups.flatMap((group) => group.results.map((result) => ({
    title: result.title,
    url: result.url,
    snippet: result.snippet
  })));
  const output = await aiJson<{ accounts: Array<{ company: string; website: string | null; rationale: string; sourceUrls: string[] }> }>(
    env,
    "You identify plausible B2B target accounts. Only name organisations present in the supplied evidence. Never invent company names or websites.",
    `OFFER: ${input.offer}\nMARKET: ${input.market}\nEVIDENCE:\n${evidencePrompt(evidence)}\nReturn {"accounts":[{"company":"","website":null,"rationale":"","sourceUrls":[]}]} with at most ${Math.min(30, input.limit || 15)} accounts. Every account must have sourceUrls from supplied evidence.`,
    { accounts: [] }
  );

  const created: Array<{ accountId: string; company: string; website: string | null; rationale: string }> = [];
  for (const item of output.accounts.slice(0, Math.min(30, input.limit || 15))) {
    if (!item.company || !item.sourceUrls?.length) continue;
    const accountId = await createAccount(env, { name: item.company, website: item.website, segment: input.market, source: "autonomous_discovery", tier: 3 });
    await addSignal(env, {
      accountId,
      signalType: "discovered",
      title: "Account discovered for active market",
      detail: item.rationale,
      sourceUrl: item.sourceUrls[0],
      confidence: 60,
      metadata: { sourceUrls: item.sourceUrls }
    });
    created.push({ accountId, company: item.company, website: item.website, rationale: item.rationale });
  }
  return created;
}

export async function discoverPartners(
  env: Env,
  input: { market: string; complementaryTo: string; limit?: number }
): Promise<Array<{ partnerId: string; name: string; website: string | null; rationale: string }>> {
  const groups = await searchMany(env, [
    `${input.market} complementary service providers partners`,
    `${input.complementaryTo} implementation partners ${input.market}`,
    `${input.market} consultants agencies directory`
  ], 8);
  const evidence = groups.flatMap((group) => group.results.map((result) => ({ title: result.title, url: result.url, snippet: result.snippet })));
  const output = await aiJson<{ partners: Array<{ name: string; website: string | null; partnerType: string; rationale: string; sourceUrls: string[] }> }>(
    env,
    "You identify plausible channel/referral partners. Only name organisations present in supplied evidence. Avoid direct competitors unless a coopetition case is explicit.",
    `MARKET: ${input.market}\nCOMPLEMENTARY TO: ${input.complementaryTo}\nEVIDENCE:\n${evidencePrompt(evidence)}\nReturn {"partners":[{"name":"","website":null,"partnerType":"","rationale":"","sourceUrls":[]}]}.`,
    { partners: [] }
  );
  const saved: Array<{ partnerId: string; name: string; website: string | null; rationale: string }> = [];
  for (const partner of output.partners.slice(0, Math.min(20, input.limit || 10))) {
    if (!partner.name || !partner.sourceUrls?.length) continue;
    const existing = await env.DB.prepare("SELECT partner_id FROM partner_candidates WHERE website = ? OR name = ? LIMIT 1")
      .bind(partner.website || "", partner.name).first<{ partner_id: string }>();
    const partnerId = existing?.partner_id || id("partner");
    if (!existing) {
      await env.DB.prepare(
        `INSERT INTO partner_candidates (
          partner_id, name, website, partner_type, fit_score, rationale, evidence_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 60, ?, ?, 'candidate', ?, ?)`
      ).bind(partnerId, partner.name, partner.website || null, partner.partnerType || "complementary", partner.rationale, JSON.stringify(partner.sourceUrls), isoNow(), isoNow()).run();
    }
    saved.push({ partnerId, name: partner.name, website: partner.website, rationale: partner.rationale });
  }
  return saved;
}

export async function nextBestAccounts(env: Env, limit = 20): Promise<NextBestAccount[]> {
  const rows = await env.DB.prepare(
    `SELECT a.account_id, a.name, a.domain, a.tier, a.lifecycle_stage,
       MAX(s.captured_at) AS last_signal_at,
       MAX(s.title) AS signal_title,
       MAX(s.confidence) AS signal_confidence,
       MAX(o.probability) AS probability,
       MAX(o.stage) AS opportunity_stage
     FROM commercial_accounts a
     LEFT JOIN commercial_signals s ON s.account_id = a.account_id
     LEFT JOIN opportunities o ON o.account_id = a.account_id AND o.stage NOT IN ('won','lost','closed')
     WHERE a.status = 'active'
     GROUP BY a.account_id
     ORDER BY a.tier ASC, last_signal_at DESC
     LIMIT ?`
  ).bind(Math.max(1, Math.min(100, limit * 3))).all<any>();

  return rows.results
    .map((row) => {
      const recent = row.last_signal_at ? Math.max(0, 30 - Math.floor((Date.now() - new Date(row.last_signal_at).getTime()) / 86_400_000)) : 0;
      const signal = Number(row.signal_confidence || 0);
      const probability = Number(row.probability || 0);
      const tierBonus = row.tier === 1 ? 25 : row.tier === 2 ? 15 : 5;
      const score = Math.min(100, tierBonus + recent + signal * 0.3 + probability * 0.25);
      const reasons = [
        row.tier <= 2 ? "Priority account tier." : null,
        row.last_signal_at ? "Recent commercial signal." : null,
        probability >= 50 ? "Existing opportunity shows meaningful buying intent." : null
      ].filter(Boolean) as string[];
      return {
        accountId: row.account_id,
        name: row.name,
        domain: row.domain,
        score: Math.round(score),
        reasons,
        strongestSignal: row.signal_title || null,
        suggestedAction: row.opportunity_stage === "proposal" ? "Advance the open proposal with evidence-led follow-up." :
          row.last_signal_at ? "Review the new signal and decide whether it creates a credible reason to contact." :
          "Research for a current trigger before outreach."
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function opportunityMap(env: Env, limit = 200): Promise<Record<string, unknown>[]> {
  const rows = await env.DB.prepare(
    `SELECT a.*, 
       (SELECT COUNT(*) FROM commercial_signals s WHERE s.account_id = a.account_id) AS signal_count,
       (SELECT MAX(captured_at) FROM commercial_signals s WHERE s.account_id = a.account_id) AS last_signal_at,
       (SELECT MAX(probability) FROM opportunities o WHERE o.account_id = a.account_id AND o.stage NOT IN ('won','lost','closed')) AS opportunity_probability
     FROM commercial_accounts a
     WHERE a.status = 'active'
     ORDER BY a.tier ASC, last_signal_at DESC
     LIMIT ?`
  ).bind(Math.max(1, Math.min(500, limit))).all<any>();
  return rows.results;
}

export async function buildReferralSuggestions(env: Env, accountId: string): Promise<Array<Record<string, unknown>>> {
  const account = await env.DB.prepare("SELECT * FROM commercial_accounts WHERE account_id = ?").bind(accountId).first<any>();
  if (!account) throw new Error("account_not_found");
  const graph = await env.DB.prepare(
    `SELECT r.*, n1.label AS from_label, n2.label AS to_label
     FROM knowledge_edges r
     JOIN knowledge_nodes n1 ON n1.node_id = r.from_node_id
     JOIN knowledge_nodes n2 ON n2.node_id = r.to_node_id
     WHERE (n1.canonical_key = ? OR n2.canonical_key = ?)
       AND r.edge_type IN ('customer_of','partner_of','invested_in','supplier_of','knows','worked_with')
     ORDER BY r.weight DESC LIMIT 30`
  ).bind(account.domain || account.account_id, account.domain || account.account_id).all<any>();
  return graph.results.map((row) => ({
    relationshipType: row.edge_type,
    from: row.from_label,
    to: row.to_label,
    strength: row.weight,
    evidence: JSON.parse(row.evidence_json || "[]"),
    action: "Consider whether a permission-based introduction is appropriate; do not auto-contact the related party."
  }));
}
