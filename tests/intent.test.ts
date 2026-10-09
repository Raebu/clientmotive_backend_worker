import { describe, expect, it } from "vitest";
import { classifyIntent, ctaFor } from "../src/services/intent";

describe("intent classification", () => {
  it("keeps early visitors in discovery", () => {
    expect(classifyIntent(8, ["page_view"])).toEqual({ score: 8, stage: "discovering" });
  });

  it("recognises evaluation intent", () => {
    expect(classifyIntent(44, ["results_view"])).toEqual({ score: 44, stage: "evaluating" });
  });

  it("prioritises an in-progress brief", () => {
    const result = classifyIntent(32, ["brief_started"]);
    expect(result.stage).toBe("brief_started");
    expect(result.score).toBeGreaterThanOrEqual(70);
  });

  it("never asks a submitted lead to submit again", () => {
    const cta = ctaFor("submitted");
    expect(cta.href).toBe("/approach/");
    expect(cta.label).not.toMatch(/brief/i);
  });

  it("offers return visitors a continuation CTA", () => {
    expect(ctaFor("brief_started").label).toBe("Continue your growth brief");
  });
});
