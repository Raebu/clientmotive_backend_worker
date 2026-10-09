export type Role = "admin" | "analyst" | "sales" | "account_manager" | "client" | "partner" | "api";

export interface ForecastResult {
  periodStart: string;
  periodEnd: string;
  weightedPipeline: number;
  committedRevenue: number;
  expectedRevenue: number;
  targetRevenue: number | null;
  revenueGap: number | null;
  requiredWins: number | null;
  requiredProposals: number | null;
  requiredMeetings: number | null;
  requiredQualifiedOpportunities: number | null;
}

export interface DealRisk {
  type: string;
  severity: number;
  rationale: string;
  action: string;
}

export interface MarginAssessment {
  expectedRevenue: number;
  deliveryCost: number;
  externalCost: number;
  grossProfit: number;
  marginPercent: number | null;
  expectedHours: number;
  contributionScore: number;
}

export interface ContactDecision {
  allowed: boolean;
  reason: string;
  suppressionMatched: boolean;
  permissionStatus: string | null;
}

export interface ModelRoute {
  model: string;
  mode: "deterministic" | "cheap_ai" | "strong_ai";
  reason: string;
  estimatedRelativeCost: number;
}
