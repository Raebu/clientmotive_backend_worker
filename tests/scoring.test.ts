import { describe, expect, it } from "vitest";
import { estimateBriefSpecificity, scoreLead } from "../src/services/scoring";

describe("lead scoring", () => {
  it("keeps dimensions separate and produces an overall tier", () => {
    const score = scoreLead({
      intentScore: 80,
      hasBusinessDomain: true,
      briefSpecificity: 82,
      problemSeverity: 75,
      timingSignals: 65,
      reachableBuyerConfidence: 80,
      companyFitConfidence: 78,
      commercialValueConfidence: 72,
      researchConfidence: 85
    });
    expect(score.fit).toBeGreaterThan(70);
    expect(score.intent).toBe(80);
    expect(["A", "B"]).toContain(score.tier);
    expect(score.reasons.length).toBeGreaterThan(0);
  });

  it("does not manufacture a strong lead from weak evidence", () => {
    const score = scoreLead({
      intentScore: 10,
      hasBusinessDomain: false,
      briefSpecificity: 20,
      problemSeverity: 25,
      timingSignals: 10,
      reachableBuyerConfidence: 20,
      companyFitConfidence: 20,
      commercialValueConfidence: 20,
      researchConfidence: 10
    });
    expect(score.overall).toBeLessThan(40);
    expect(score.tier).toBe("D");
  });

  it("rewards a substantive brief", () => {
    const short = estimateBriefSpecificity(["need leads"]);
    const detailed = estimateBriefSpecificity([
      "We sell specialist finance recruitment to UK scale-ups with 50 to 500 employees and want conversations with CFOs and finance directors.",
      "Current referrals are inconsistent and our generic outbound is producing low-quality replies."
    ]);
    expect(detailed).toBeGreaterThan(short);
  });
});
