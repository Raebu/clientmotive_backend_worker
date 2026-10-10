import { describe, expect, it } from "vitest";
import { buildValuePreview, runDiagnostic } from "../src/commercial/diagnostics";

describe("commercial diagnostics", () => {
  it("returns a real pipeline-gap calculation", () => {
    const result = runDiagnostic("pipeline_gap", [
      { key: "target", value: 100 },
      { key: "current", value: 40 },
      { key: "conversion", value: 20 },
      { key: "sales_cycle", value: 70 },
      { key: "capacity", value: 70 }
    ]);
    expect(result.metrics?.pipelineGap).toBe(60);
    expect(result.metrics?.coveragePercent).toBe(40);
    expect(result.metrics?.approximateAdditionalQualifiedOpportunitiesNeeded).toBe(300);
  });

  it("calculates account coverage", () => {
    const result = runDiagnostic("account_coverage", [
      { key: "universe", value: 200 },
      { key: "prioritised", value: 50 },
      { key: "contacts", value: 80 },
      { key: "signals", value: 50 },
      { key: "history", value: 50 }
    ]);
    expect(result.metrics?.accountPrioritisationCoveragePercent).toBe(25);
    expect(result.metrics?.contactCoveragePercent).toBe(40);
  });

  it("creates a value preview without storing anything", () => {
    const preview = buildValuePreview({
      offer: "Specialist recruitment services",
      market: "UK engineering employers",
      problem: "Generic employer outreach"
    });
    expect(preview.checks.length).toBeGreaterThanOrEqual(5);
    expect(preview.reassurance).toMatch(/not stored/i);
  });
});
