export type DiagnosticType =
  | "outbound_readiness"
  | "icp_clarity"
  | "competitor_positioning"
  | "pipeline_gap"
  | "account_coverage"
  | "recruitment_bd"
  | "channel_fit";

export interface DiagnosticAnswer {
  key: string;
  value: string | number | boolean | string[];
}

export interface DiagnosticResult {
  type: DiagnosticType;
  score: number;
  band: "strong" | "developing" | "weak";
  headline: string;
  strengths: string[];
  gaps: string[];
  nextSteps: string[];
  recommendedProductCodes: string[];
  metrics?: Record<string, number | string | null>;
}

export interface ValuePreviewInput {
  offer?: string;
  market?: string;
  problem?: string;
}

export interface ValuePreview {
  headline: string;
  checks: string[];
  reassurance: string;
}

export type CommercialTask =
  | "scan_watchlist"
  | "discover_accounts"
  | "refresh_competitor"
  | "buyer_change_scan"
  | "daily_priorities"
  | "rescue_opportunities"
  | "client_health"
  | "expansion_scan"
  | "content_digest"
  | "benchmark_refresh";

export interface CommercialQueueMessage {
  kind: "commercial";
  task: CommercialTask;
  entityId?: string;
  payload?: Record<string, unknown>;
}

export interface NextBestAccount {
  accountId: string;
  name: string;
  domain: string | null;
  score: number;
  reasons: string[];
  strongestSignal: string | null;
  suggestedAction: string;
}

export interface NextBestMessage {
  reasonForContact: string;
  evidence: string[];
  likelyPain: string;
  objectionRisk: string;
  ask: string;
  draft: string;
}

export interface CommercialDocumentDraft {
  title: string;
  sections: Array<{ heading: string; body: string }>;
  assumptions: string[];
  humanApprovalRequired: boolean;
}
