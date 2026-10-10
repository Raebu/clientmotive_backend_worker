import type { ScoreBreakdown } from "../types";

export interface ScoreInputs {
  intentScore: number;
  hasBusinessDomain: boolean;
  briefSpecificity: number;
  problemSeverity: number;
  timingSignals: number;
  reachableBuyerConfidence: number;
  companyFitConfidence: number;
  commercialValueConfidence: number;
  researchConfidence: number;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function scoreLead(input: ScoreInputs): ScoreBreakdown {
  const fit = clamp(input.companyFitConfidence * 0.8 + (input.hasBusinessDomain ? 20 : 0));
  const intent = clamp(input.intentScore);
  const need = clamp(input.problemSeverity * 0.65 + input.briefSpecificity * 0.35);
  const timing = clamp(input.timingSignals);
  const commercialPotential = clamp(input.commercialValueConfidence);
  const access = clamp(input.reachableBuyerConfidence);

  const overall = clamp(
    fit * 0.24 +
    intent * 0.18 +
    need * 0.20 +
    timing * 0.12 +
    commercialPotential * 0.16 +
    access * 0.10
  );

  const tier: ScoreBreakdown["tier"] =
    overall >= 75 ? "A" :
    overall >= 58 ? "B" :
    overall >= 40 ? "C" : "D";

  const reasons: string[] = [];
  if (fit >= 70) reasons.push("Strong company/offer fit.");
  if (intent >= 65) reasons.push("Website behaviour indicates high intent.");
  if (need >= 70) reasons.push("The stated commercial problem is substantive and specific.");
  if (timing >= 65) reasons.push("Current timing signals suggest a reason to act now.");
  if (access >= 70) reasons.push("Likely buyers appear identifiable and reachable.");
  if (commercialPotential >= 70) reasons.push("Potential engagement appears commercially meaningful.");
  if (input.researchConfidence < 45) reasons.push("Research confidence is limited; human verification is recommended.");

  return { fit, intent, need, timing, commercialPotential, access, overall, tier, reasons };
}

export function estimateBriefSpecificity(parts: string[]): number {
  const text = parts.join(" ").trim();
  if (!text) return 0;
  const words = text.split(/\s+/).filter(Boolean);
  const unique = new Set(words.map((word) => word.toLowerCase().replace(/[^a-z0-9]/g, ""))).size;
  const wordScore = Math.min(70, words.length * 0.6);
  const varietyScore = Math.min(30, unique * 0.35);
  return clamp(wordScore + varietyScore);
}
