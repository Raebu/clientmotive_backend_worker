import type { Env } from "../types";
import { aiJson } from "../services/ai";

function tidy(value: unknown, max = 320): string {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function list(values: unknown, maxItems: number, maxChars = 240): string[] {
  return Array.isArray(values) ? values.slice(0, maxItems).map((item) => tidy(item, maxChars)).filter(Boolean) : [];
}

export interface PublicIcpInput {
  offer: string;
  bestFit: string;
  geography: string;
  companySize: string;
  trigger: string;
  exclusions: string;
  knownBuyer: string;
}

export interface PublicBuyerInput {
  offer: string;
  targetCustomer: string;
  problem: string;
  dealComplexity: string;
  knownBuyer: string;
}

export async function buildPublicIcpBrief(env: Env, input: PublicIcpInput): Promise<Record<string, unknown>> {
  const fallback = {
    headline: "A working ICP built from the commercial context you supplied.",
    idealCustomerSummary: [
      input.bestFit,
      input.companySize ? "Typical size: " + input.companySize : "",
      input.geography ? "Geography: " + input.geography : ""
    ].filter(Boolean).join(" · "),
    fitCriteria: [
      input.bestFit,
      input.companySize ? "Matches the stated company-size range: " + input.companySize : "",
      input.geography ? "Operates in the stated geography: " + input.geography : "",
      input.trigger ? "Shows one of the stated trigger conditions: " + input.trigger : "Has a current business reason to address the problem"
    ].filter(Boolean).slice(0, 5),
    negativeIcp: input.exclusions ? [input.exclusions] : ["Organisations where the problem is too weak or the economics do not justify action"],
    triggerEvents: input.trigger ? [input.trigger] : ["A material change that increases urgency or makes the existing approach less effective"],
    buyerCommittee: [
      { role: input.knownBuyer || "Economic buyer", type: "Economic buyer", why: "Owns the commercial outcome, budget or decision." },
      { role: "Functional champion", type: "Champion", why: "Feels the problem strongly enough to move the decision internally." },
      { role: "Operational owner", type: "User / operator", why: "Will work with the solution or live with the result." }
    ],
    qualificationQuestions: [
      "What makes this problem important enough to solve now?",
      "What happens if nothing changes?",
      "Who owns the outcome and who can block the decision?",
      "What evidence would make this worth prioritising?",
      "What would make this account a poor fit even if the firmographics look right?"
    ],
    researchGaps: [
      "Validate the economic buyer and buying committee.",
      "Validate which trigger events correlate with real urgency.",
      "Test whether the stated exclusions predict poor commercial fit."
    ],
    nextMove: "Use the ICP as a research filter, then test it against real accounts before scaling outreach."
  };

  const ai = await aiJson<any>(
    env,
    "You are ClientMotive's public ICP strategist. Turn the user's brief into a practical B2B ideal-customer-profile hypothesis. Use only the supplied information and general commercial reasoning. Do not invent named companies, market statistics, proof, customers, results or facts about an industry that were not supplied. Be specific without pretending certainty.",
    [
      "OFFER: " + input.offer,
      "WHO GETS MOST VALUE: " + input.bestFit,
      "GEOGRAPHY: " + (input.geography || "Not supplied"),
      "COMPANY SIZE: " + (input.companySize || "Not supplied"),
      "URGENCY / TRIGGERS: " + (input.trigger || "Not supplied"),
      "EXCLUSIONS: " + (input.exclusions || "Not supplied"),
      "KNOWN BUYER: " + (input.knownBuyer || "Not supplied"),
      "",
      "Return JSON with:",
      "- headline: max 18 words",
      "- idealCustomerSummary: max 55 words",
      "- fitCriteria: 4-6 concise criteria",
      "- negativeIcp: 3-5 concise exclusions or disqualifiers",
      "- triggerEvents: 3-5 trigger hypotheses",
      "- buyerCommittee: 3-5 objects {role,type,why}; roles are hypotheses, not asserted facts",
      "- qualificationQuestions: 5 sharp questions",
      "- researchGaps: 3-4 things that still need evidence",
      "- nextMove: max 30 words"
    ].join("\n"),
    fallback,
    1200
  );

  const committee = Array.isArray(ai.buyerCommittee) ? ai.buyerCommittee.slice(0, 5).map((row:any) => ({
    role: tidy(row?.role, 120),
    type: tidy(row?.type, 80),
    why: tidy(row?.why, 240)
  })).filter((row:any) => row.role && row.why) : fallback.buyerCommittee;

  return {
    basis: "Built from your brief · working hypothesis",
    headline: tidy(ai.headline || fallback.headline, 180),
    idealCustomerSummary: tidy(ai.idealCustomerSummary || fallback.idealCustomerSummary, 620),
    fitCriteria: list(ai.fitCriteria, 6),
    negativeIcp: list(ai.negativeIcp, 5),
    triggerEvents: list(ai.triggerEvents, 5),
    buyerCommittee: committee,
    qualificationQuestions: list(ai.qualificationQuestions, 5),
    researchGaps: list(ai.researchGaps, 4),
    nextMove: tidy(ai.nextMove || fallback.nextMove, 320),
    evidenceNote: "This is a structured hypothesis built from the information you supplied. It has not yet been validated against market evidence or real accounts."
  };
}

export async function buildPublicBuyerMap(env: Env, input: PublicBuyerInput): Promise<Record<string, unknown>> {
  const fallback = {
    summary: "A first-pass map of the people who may shape this decision.",
    committee: [
      { roleType: "Economic buyer", titleHypothesis: input.knownBuyer || "Executive or functional owner", whyTheyCare: "Owns the business outcome or budget.", likelyObjection: "Is the value material enough to prioritise?", proofNeeded: "Commercial case, expected outcome and risk of inaction." },
      { roleType: "Champion", titleHypothesis: "Functional leader closest to the problem", whyTheyCare: "Needs the problem solved and can build internal momentum.", likelyObjection: "Will this work in our context?", proofNeeded: "Relevant methodology, examples and implementation clarity." },
      { roleType: "Operational user", titleHypothesis: "Team or manager affected by the change", whyTheyCare: "Feels the day-to-day friction.", likelyObjection: "Will this create more work?", proofNeeded: "Workflow, usability and practical impact." },
      { roleType: "Blocker / validator", titleHypothesis: "Finance, procurement, legal, IT or risk depending on the sale", whyTheyCare: "Protects cost, risk and governance.", likelyObjection: "Does this meet our controls and buying requirements?", proofNeeded: "Commercial terms, security, compliance and implementation evidence." }
    ],
    buyingPath: [
      "Problem becomes important enough to investigate.",
      "A champion validates relevance and builds internal support.",
      "The economic buyer tests value, priority and budget.",
      "Risk, procurement or technical stakeholders validate the route to purchase."
    ],
    discoveryQuestions: [
      "Who owns the business outcome if this problem is solved?",
      "Who experiences the problem most directly?",
      "Who can approve budget and who can stop the decision?",
      "What proof would each stakeholder need to move forward?",
      "What internal event would make the decision urgent?"
    ],
    multithreadingRisks: [
      "Relying on one contact without validating decision influence.",
      "Messaging every stakeholder with the same value proposition.",
      "Discovering procurement or technical blockers too late."
    ],
    nextMove: "Validate the committee against one real target account before choosing a person to contact."
  };

  const ai = await aiJson<any>(
    env,
    "You are ClientMotive's public buying-committee strategist. Build a practical B2B stakeholder map from the user's own commercial context. Do not invent named people, companies, statistics or unsupported industry facts. Treat titles as hypotheses. Explain why roles matter, likely objections and what proof each role may need.",
    [
      "OFFER: " + input.offer,
      "TARGET CUSTOMER: " + input.targetCustomer,
      "PROBLEM SOLVED: " + input.problem,
      "DEAL COMPLEXITY: " + (input.dealComplexity || "Not supplied"),
      "KNOWN BUYER: " + (input.knownBuyer || "Not supplied"),
      "",
      "Return JSON with:",
      "- summary: max 45 words",
      "- committee: 4-6 objects {roleType,titleHypothesis,whyTheyCare,likelyObjection,proofNeeded}",
      "- buyingPath: 4-6 concise stages",
      "- discoveryQuestions: 5 sharp questions",
      "- multithreadingRisks: 3-4 risks",
      "- nextMove: max 30 words"
    ].join("\n"),
    fallback,
    1200
  );

  const committee = Array.isArray(ai.committee) ? ai.committee.slice(0, 6).map((row:any) => ({
    roleType: tidy(row?.roleType, 90),
    titleHypothesis: tidy(row?.titleHypothesis, 140),
    whyTheyCare: tidy(row?.whyTheyCare, 260),
    likelyObjection: tidy(row?.likelyObjection, 260),
    proofNeeded: tidy(row?.proofNeeded, 260)
  })).filter((row:any) => row.roleType && row.titleHypothesis) : fallback.committee;

  return {
    basis: "Built from your brief · role hypotheses",
    summary: tidy(ai.summary || fallback.summary, 520),
    committee,
    buyingPath: list(ai.buyingPath, 6),
    discoveryQuestions: list(ai.discoveryQuestions, 5),
    multithreadingRisks: list(ai.multithreadingRisks, 4),
    nextMove: tidy(ai.nextMove || fallback.nextMove, 320),
    evidenceNote: "This is a buying-committee hypothesis, not a claim about a specific company. Validate actual responsibilities before outreach."
  };
}
