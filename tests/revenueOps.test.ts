import { describe, expect, it } from "vitest";
import { assessMargin, calculateForecast, detectDealRisks } from "../src/ops/revenue";
import { routeModel } from "../src/ops/governance";

describe("revenue operations", () => {
  it("works backwards from a revenue gap", () => {
    const result = calculateForecast({
      periodStart: "2026-10-01T00:00:00.000Z",
      periodEnd: "2026-10-31T23:59:59.000Z",
      targetRevenue: 100000,
      committedRevenue: 10000,
      opportunities: [
        { value: 30000, probability: 50, stage: "qualified" },
        { value: 20000, probability: 25, stage: "proposal" }
      ],
      averageDealValue: 10000,
      proposalToWinRate: 50,
      meetingToProposalRate: 50,
      qualifiedToMeetingRate: 50
    });
    expect(result.expectedRevenue).toBe(30000);
    expect(result.revenueGap).toBe(70000);
    expect(result.requiredWins).toBe(7);
    expect(result.requiredProposals).toBe(14);
    expect(result.requiredMeetings).toBe(28);
    expect(result.requiredQualifiedOpportunities).toBe(56);
  });

  it("calculates margin without hiding delivery cost", () => {
    const result = assessMargin({
      expectedRevenue: 10000,
      deliveryCost: 4000,
      externalCost: 1000,
      expectedHours: 40
    });
    expect(result.grossProfit).toBe(5000);
    expect(result.marginPercent).toBe(50);
    expect(result.contributionScore).toBeGreaterThan(0);
  });

  it("flags single-threaded, stale advanced opportunities", () => {
    const risks = detectDealRisks({
      stage: "proposal",
      probability: 70,
      lastActivityAt: new Date(Date.now() - 30 * 86400000).toISOString(),
      nextAction: null,
      contactRoles: ["champion"],
      contactCount: 1,
      hasEconomicBuyer: false,
      hasChampion: true,
      procurementBlockers: ["security questionnaire outstanding"]
    });
    const types = risks.map((risk) => risk.type);
    expect(types).toContain("stalled");
    expect(types).toContain("no_next_step");
    expect(types).toContain("no_economic_buyer");
    expect(types).toContain("single_threaded");
    expect(types).toContain("procurement");
  });

  it("routes deterministic work away from AI", () => {
    const route = routeModel({
      capability: "forecast",
      complexity: 90,
      requiresReasoning: false,
      deterministicPossible: true,
      budgetRemainingPercent: 100
    });
    expect(route.mode).toBe("deterministic");
    expect(route.estimatedRelativeCost).toBe(0);
  });

  it("falls back to the cheap model when budget is nearly exhausted", () => {
    const route = routeModel({
      capability: "research synthesis",
      complexity: 90,
      requiresReasoning: true,
      deterministicPossible: false,
      budgetRemainingPercent: 3,
      cheapModel: "cheap",
      strongModel: "strong"
    });
    expect(route.model).toBe("cheap");
    expect(route.mode).toBe("cheap_ai");
  });
});
