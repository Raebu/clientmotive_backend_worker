import type { Env } from "./types";

export function intEnv(value: string | undefined, fallback: number, min = 1, max = 10_000): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function cfg(env: Env) {
  return {
    environment: env.ENVIRONMENT || "development",
    publicOrigin: env.PUBLIC_ORIGIN || "https://www.clientmotive.com",
    aiModel: env.AI_MODEL || "@cf/zai-org/glm-4.7-flash",
    searchProvider: (env.SEARCH_PROVIDER || "tavily").toLowerCase(),
    maxSearchesPerLead: intEnv(env.MAX_SEARCHES_PER_LEAD, 12, 1, 40),
    maxPagesPerCompany: intEnv(env.MAX_PAGES_PER_COMPANY, 8, 1, 20),
    retentionDays: intEnv(env.INTENT_EVENT_RETENTION_DAYS, 90, 7, 365)
  };
}
