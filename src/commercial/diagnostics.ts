import type { DiagnosticAnswer, DiagnosticResult, DiagnosticType, ValuePreview, ValuePreviewInput } from "./types";

const questionWeight: Record<DiagnosticType, string[]> = {
  outbound_readiness: ["market", "buyers", "proof", "infrastructure", "messaging", "followup", "crm"],
  icp_clarity: ["segment", "buyer", "exclusions", "trigger", "problem", "proof"],
  competitor_positioning: ["alternatives", "difference", "proof", "buyer_language", "pricing_context"],
  pipeline_gap: ["target", "current", "conversion", "sales_cycle", "capacity"],
  account_coverage: ["universe", "prioritised", "contacts", "signals", "history"],
  recruitment_bd: ["employer_segment", "roles", "specialism", "proof", "trigger", "followup"],
  channel_fit: ["buyer", "urgency", "searchability", "deal_value", "market_size", "content_fit", "partner_fit"]
};

function numeric(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.min(100, value));
  if (typeof value === "boolean") return value ? 100 : 0;
  if (Array.isArray(value)) return Math.min(100, value.length * 25);
  const text = String(value || "").trim();
  if (!text) return 0;
  const rawNumber = Number(text.replace(/[^0-9.-]/g, ""));
  if (Number.isFinite(rawNumber) && text.match(/[0-9]/)) return Math.max(0, Math.min(100, rawNumber));
  if (/^(yes|clear|defined|strong|complete|good)$/i.test(text)) return 90;
  if (/^(no|none|unknown|weak|poor)$/i.test(text)) return 15;
  return Math.min(90, 30 + text.split(/\s+/).length * 4);
}

function rawNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function runDiagnostic(type: DiagnosticType, answers: DiagnosticAnswer[]): DiagnosticResult {
  const expected = questionWeight[type];
  const byKey = new Map(answers.map((answer) => [answer.key, answer.value]));
  const componentScores = expected.map((key) => numeric(byKey.get(key)));
  const score = Math.round(componentScores.reduce((sum, value) => sum + value, 0) / Math.max(1, componentScores.length));
  const gaps = expected
    .map((key, index) => ({ key, score: componentScores[index] || 0 }))
    .filter((item) => item.score < 55)
    .sort((a, b) => a.score - b.score)
    .slice(0, 4)
    .map((item) => item.key.replaceAll("_", " "));
  const strengths = expected
    .map((key, index) => ({ key, score: componentScores[index] || 0 }))
    .filter((item) => item.score >= 70)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((item) => item.key.replaceAll("_", " "));
  const band: DiagnosticResult["band"] = score >= 72 ? "strong" : score >= 48 ? "developing" : "weak";
  const products =
    type === "icp_clarity" ? ["icp_sprint"] :
    type === "competitor_positioning" ? ["competitive_sprint"] :
    type === "outbound_readiness" || type === "recruitment_bd" ? ["outbound_audit", "campaign_architecture"] :
    type === "channel_fit" ? ["campaign_architecture"] :
    ["outbound_audit"];

  const metrics: Record<string, number | string | null> = {};
  if (type === "pipeline_gap") {
    const target = rawNumber(byKey.get("target"));
    const current = rawNumber(byKey.get("current"));
    const conversion = rawNumber(byKey.get("conversion"));
    if (target !== null && current !== null) {
      metrics.targetPipeline = target;
      metrics.currentPipeline = current;
      metrics.pipelineGap = Math.max(0, target - current);
      metrics.coveragePercent = target > 0 ? Math.round((current / target) * 1000) / 10 : null;
      if (conversion !== null && conversion > 0) {
        metrics.approximateAdditionalQualifiedOpportunitiesNeeded = Math.ceil(Math.max(0, target - current) / (conversion / 100));
      }
    }
  }
  if (type === "account_coverage") {
    const universe = rawNumber(byKey.get("universe"));
    const prioritised = rawNumber(byKey.get("prioritised"));
    const contacts = rawNumber(byKey.get("contacts"));
    if (universe !== null && universe > 0) {
      metrics.accountPrioritisationCoveragePercent = prioritised !== null ? Math.round((prioritised / universe) * 1000) / 10 : null;
      metrics.contactCoveragePercent = contacts !== null ? Math.round((contacts / universe) * 1000) / 10 : null;
    }
  }

  return {
    type,
    score,
    band,
    headline:
      band === "strong" ? "The fundamentals are in place; the next opportunity is sharper execution." :
      band === "developing" ? "There is enough to work with, but a few gaps will weaken execution if left unresolved." :
      "The biggest opportunity is to strengthen the commercial foundations before scaling activity.",
    strengths,
    gaps,
    nextSteps: gaps.length
      ? gaps.map((gap) => "Clarify " + gap + " before increasing activity.")
      : ["Turn the strongest assumptions into measurable campaign hypotheses."],
    recommendedProductCodes: products,
    metrics: Object.keys(metrics).length ? metrics : undefined
  };
}

export function buildValuePreview(input: ValuePreviewInput): ValuePreview {
  const offer = (input.offer || "").trim();
  const market = (input.market || "").trim();
  const problem = (input.problem || "").trim();
  const checks = [
    market ? "Map the most relevant buyer groups inside " + market.slice(0, 120) + "." : "Identify the buyer groups most likely to care.",
    offer ? "Compare how this offer is positioned against direct, adjacent and status-quo alternatives." : "Assess the offer against competing ways the buyer can solve the problem.",
    "Identify commercially useful trigger events and reasons to contact.",
    "Rank the channels most likely to reach the buyer instead of defaulting to one platform.",
    problem ? "Test whether the stated problem points to an ICP, positioning, channel or execution constraint." : "Diagnose whether the main constraint is ICP, positioning, channel or execution."
  ];
  return {
    headline: "We will turn your answers into a commercial picture, not just a contact request.",
    checks,
    reassurance: "Your unfinished answers are used only to generate this on-page preview and are not stored by this endpoint."
  };
}
