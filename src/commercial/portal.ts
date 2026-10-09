import type { Env } from "../types";
import { id, isoNow } from "../lib/ids";
import { hashValue, timingSafeEqual } from "../lib/security";
import { nextBestAccounts } from "./acquisition";
import type { NextBestAccount } from "./types";

export async function createPortfolio(
  env: Env,
  input: { ownerAccountId: string; name: string; productCode?: string | null }
): Promise<string> {
  const portfolioId = id("portfolio");
  const now = isoNow();
  await env.DB.prepare(
    "INSERT INTO account_portfolios (portfolio_id,owner_account_id,name,product_code,status,created_at,updated_at) VALUES (?,?,?,?, 'active', ?,?)"
  ).bind(portfolioId, input.ownerAccountId, input.name, input.productCode || null, now, now).run();
  return portfolioId;
}

export async function addPortfolioAccount(
  env: Env,
  input: { portfolioId: string; targetAccountId: string; tier?: number; notes?: string | null }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO portfolio_accounts (portfolio_id,target_account_id,tier,status,notes,created_at)
     VALUES (?,?,?,'watching',?,?)
     ON CONFLICT(portfolio_id,target_account_id) DO UPDATE SET tier=excluded.tier,status='watching',notes=excluded.notes`
  ).bind(input.portfolioId, input.targetAccountId, Math.max(1, Math.min(3, input.tier || 3)), input.notes || null, isoNow()).run();
}

export async function issuePortalToken(
  env: Env,
  accountId: string,
  expiresInDays = 90
): Promise<{ token: string; tokenId: string; expiresAt: string }> {
  const token = "cmp_" + crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const tokenId = id("ptok");
  const expiresAt = new Date(Date.now() + Math.max(1, Math.min(365, expiresInDays)) * 86_400_000).toISOString();
  await env.DB.prepare(
    "INSERT INTO client_portal_tokens (token_id,account_id,token_hash,status,expires_at,created_at) VALUES (?,?,?,'active',?,?)"
  ).bind(tokenId, accountId, await hashValue(token), expiresAt, isoNow()).run();
  return { token, tokenId, expiresAt };
}

export async function verifyPortalToken(env: Env, accountId: string, token: string): Promise<boolean> {
  const hash = await hashValue(token);
  const row = await env.DB.prepare(
    "SELECT * FROM client_portal_tokens WHERE account_id=? AND status='active' AND token_hash=? LIMIT 1"
  ).bind(accountId, hash).first<any>();
  if (!row || !timingSafeEqual(row.token_hash, hash)) return false;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return false;
  await env.DB.prepare("UPDATE client_portal_tokens SET last_used_at=? WHERE token_id=?").bind(isoNow(), row.token_id).run();
  return true;
}

export async function clientDashboard(env: Env, accountId: string): Promise<Record<string, unknown>> {
  const [account, portfolios, health, subscriptions] = await Promise.all([
    env.DB.prepare("SELECT account_id,name,domain,segment,lifecycle_stage,tier FROM commercial_accounts WHERE account_id=?").bind(accountId).first<any>(),
    env.DB.prepare("SELECT * FROM account_portfolios WHERE owner_account_id=? AND status='active'").bind(accountId).all<any>(),
    env.DB.prepare("SELECT * FROM client_health WHERE account_id=?").bind(accountId).first<any>(),
    env.DB.prepare(
      "SELECT s.*,p.name AS product_name FROM subscriptions s JOIN commercial_products p ON p.product_code=s.product_code WHERE s.account_id=? AND s.status='active'"
    ).bind(accountId).all<any>()
  ]);
  if (!account) throw new Error("account_not_found");
  const portfolioData: Record<string, unknown>[] = [];
  for (const portfolio of portfolios.results) {
    const targets = await env.DB.prepare(
      `SELECT pa.tier AS portfolio_tier,pa.status AS portfolio_status,pa.notes,
        a.account_id,a.name,a.domain,a.segment,
        (SELECT title FROM commercial_signals s WHERE s.account_id=a.account_id ORDER BY captured_at DESC LIMIT 1) AS latest_signal,
        (SELECT source_url FROM commercial_signals s WHERE s.account_id=a.account_id ORDER BY captured_at DESC LIMIT 1) AS latest_signal_source,
        (SELECT captured_at FROM commercial_signals s WHERE s.account_id=a.account_id ORDER BY captured_at DESC LIMIT 1) AS latest_signal_at
       FROM portfolio_accounts pa JOIN commercial_accounts a ON a.account_id=pa.target_account_id
       WHERE pa.portfolio_id=? ORDER BY pa.tier,a.name`
    ).bind(portfolio.portfolio_id).all<any>();
    portfolioData.push({
      portfolio: { id: portfolio.portfolio_id, name: portfolio.name, productCode: portfolio.product_code },
      accounts: targets.results
    });
  }
  return {
    account,
    health: health || null,
    subscriptions: subscriptions.results,
    portfolios: portfolioData,
    generatedAt: isoNow()
  };
}

export async function suggestPortfolioPriorities(env: Env, portfolioId: string, limit = 10): Promise<NextBestAccount[]> {
  const rows = await env.DB.prepare(
    `SELECT a.account_id FROM portfolio_accounts pa
     JOIN commercial_accounts a ON a.account_id=pa.target_account_id
     WHERE pa.portfolio_id=? AND pa.status='watching'`
  ).bind(portfolioId).all<{ account_id: string }>();
  const allowed = new Set(rows.results.map((r) => r.account_id));
  const ranked = await nextBestAccounts(env, 100);
  return ranked.filter((item) => allowed.has(item.accountId)).slice(0, limit);
}
