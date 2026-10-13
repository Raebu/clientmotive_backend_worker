export interface SimpleRateLimiter {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  RESEARCH_QUEUE: Queue<ResearchMessage>;
  AI?: Ai;
  EVENT_RATE_LIMITER?: SimpleRateLimiter;
  INTAKE_RATE_LIMITER?: SimpleRateLimiter;
  ENVIRONMENT?: string;
  PUBLIC_ORIGIN?: string;
  AI_MODEL?: string;
  AI_STRONG_MODEL?: string;
  SEARCH_PROVIDER?: string;
  MAX_SEARCHES_PER_LEAD?: string;
  MAX_PAGES_PER_COMPANY?: string;
  INTENT_EVENT_RETENTION_DAYS?: string;

  WEBSITE_SHARED_SECRET?: string;
  ADMIN_API_TOKEN?: string;
  TAVILY_API_KEY?: string;
  BRAVE_SEARCH_API_KEY?: string;
  RESEND_API_KEY?: string;
  ALERT_EMAIL_TO?: string;
  ALERT_EMAIL_FROM?: string;
  SLACK_WEBHOOK_URL?: string;
  HUBSPOT_ACCESS_TOKEN?: string;
  CRM_CREDENTIAL_ENCRYPTION_KEY?: string;
  INTEGRATION_SHARED_SECRET?: string;
  CRM_WEBHOOK_SECRET?: string;
  INBOX_WEBHOOK_SECRET?: string;
  BILLING_WEBHOOK_SECRET?: string;
  ESIGN_WEBHOOK_SECRET?: string;
  ENRICHMENT_API_URL?: string;
  ENRICHMENT_API_KEY?: string;
  EMAIL_VERIFICATION_API_URL?: string;
  EMAIL_VERIFICATION_API_KEY?: string;
  HUNTER_API_KEY?: string;
  QUICKEMAILVERIFICATION_API_KEY?: string;
  APOLLO_API_KEY?: string;
  OUTBOUND_FROM?: string;
  OUTBOUND_REPLY_TO?: string;
  COMPANIES_HOUSE_API_KEY?: string;
  BILLING_PROVIDER?: string;
  CRM_PROVIDER?: string;
  ESIGN_PROVIDER?: string;
}

export type VisitorStage =
  | "discovering"
  | "exploring"
  | "evaluating"
  | "high_intent"
  | "brief_started"
  | "submitted";

export interface IntentEvent {
  eventId?: string;
  visitorId: string;
  sessionId: string;
  eventType: string;
  path: string;
  referrer?: string | null;
  properties?: Record<string, unknown>;
  occurredAt?: string;
}

export interface IntentContext {
  visitorId: string;
  intentScore: number;
  stage: VisitorStage;
  recommendedCta: {
    label: string;
    href: string;
    reason: string;
  };
  strongestSignals: string[];
}

export interface LeadIntake {
  idempotencyKey: string;
  visitorId?: string | null;
  sessionId?: string | null;
  name: string;
  email: string;
  entityType: "individual" | "company" | "public_sector" | "nonprofit" | "other";
  company: string;
  website?: string | null;
  offer: string;
  market: string;
  problem: string;
  outcome: string;
  sourcePath?: string | null;
  source?: string | null;
  utm?: Record<string, string | null>;
  consent?: {
    privacyNoticeVersion?: string;
    marketing?: boolean;
  };
}

export type ResearchStage =
  | "company_profile"
  | "competitive_landscape"
  | "marketing_intelligence"
  | "market_channels"
  | "buyers_icp"
  | "target_accounts"
  | "commercial_capacity"
  | "scoring"
  | "dossier"
  | "notify";

export interface ResearchMessage {
  jobId: string;
  leadId: string;
  stage: ResearchStage;
  attempt?: number;
}

export interface EvidenceItem {
  sourceUrl: string;
  title?: string;
  snippet: string;
  sourceType: "website" | "search" | "brief" | "derived";
  query?: string;
  capturedAt: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
}

export interface ScoreBreakdown {
  fit: number;
  intent: number;
  need: number;
  timing: number;
  commercialPotential: number;
  access: number;
  overall: number;
  tier: "A" | "B" | "C" | "D";
  reasons: string[];
}

export interface CompanyProfile {
  companyName: string;
  domain: string | null;
  summary: string;
  offers: string[];
  industries: string[];
  geographies: string[];
  buyerHints: string[];
  proofPoints: string[];
  risks: string[];
  sources: string[];
}


export interface CommercialCapacityProfile {
  entityType: "individual" | "solo_business" | "startup" | "small_business" | "mid_market" | "enterprise" | "public_sector" | "nonprofit" | "unknown";
  employeeBand: "1" | "2-10" | "11-50" | "51-250" | "251-1000" | "1001+" | "unknown";
  revenueBand: "pre_revenue" | "under_500k" | "500k-2m" | "2m-10m" | "10m-50m" | "50m-250m" | "250m+" | "unknown";
  fundingBand: "none_visible" | "under_1m" | "1m-5m" | "5m-25m" | "25m+" | "unknown";
  procurementComplexity: "low" | "medium" | "high";
  confidence: number;
  recommendedOffer: "starter_signal" | "growth_snapshot" | "growth_snapshot_plus" | "enterprise_intelligence";
  priceFloorGbp: number;
  targetPriceGbp: number;
  priceCeilingGbp: number;
  pricingRationale: string[];
  evidenceUrls: string[];
}

export interface CompetitorAnalysis {
  name: string;
  website: string | null;
  competitorType: "direct" | "adjacent" | "status_quo" | "emerging";
  summary: string;
  positioning: string;
  strengths: string[];
  weaknesses: string[];
  differentiationOpportunity: string;
  sourceUrls: string[];
}

export interface ChannelRecommendation {
  channel: string;
  priority: "high" | "medium" | "low";
  role: string;
  why: string;
  prerequisites: string[];
  firstExperiment: string;
  evidence: string[];
}

export interface BuyerRole {
  role: string;
  roleType: "economic_buyer" | "champion" | "user" | "influencer" | "blocker";
  pain: string;
  trigger: string;
  messageAngle: string;
  titleVariants: string[];
}

export interface TargetAccount {
  company: string;
  website: string | null;
  rationale: string;
  triggers: string[];
  likelyBuyerRoles: string[];
  sourceUrls: string[];
}

export interface Dossier {
  executiveSummary: string;
  opportunityThesis: string;
  whatWeKnow: string[];
  competitiveSummary: string;
  channelSummary: string;
  buyerSummary: string;
  recommendedFirstMove: string;
  nextBestActions: Array<{
    action: string;
    owner: "clientmotive" | "prospect";
    priority: "now" | "next" | "later";
    reason: string;
  }>;
  prospectSnapshot: {
    headline: string;
    observations: string[];
  };
}
