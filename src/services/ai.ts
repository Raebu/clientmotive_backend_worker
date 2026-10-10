import type { Env } from "../types";
import { cfg } from "../config";

function workflowFor(system: string): string {
  const value = system.toLowerCase();
  if (value.includes("editorial") || value.includes("newsletter") || value.includes("content")) return "content_intelligence";
  if (value.includes("account research") || value.includes("target account") || value.includes("prospecting")) return "autonomous_prospecting";
  return "lead_research";
}

async function takeAiBudget(env: Env, workflow: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      "SELECT budget_id,max_ai_calls,spent_ai_calls,resets_at FROM workflow_budgets WHERE tenant_id='tenant_clientmotive' AND workflow=? LIMIT 1"
    ).bind(workflow).first<any>();
    if (!row) return true;
    if (row.resets_at && new Date(row.resets_at).getTime() <= Date.now()) {
      const next = new Date(); next.setUTCMonth(next.getUTCMonth() + 1, 1); next.setUTCHours(0,0,0,0);
      await env.DB.prepare("UPDATE workflow_budgets SET spent_search_calls=0,spent_ai_calls=0,spent_cost=0,resets_at=?,updated_at=? WHERE budget_id=?")
        .bind(next.toISOString(), new Date().toISOString(), row.budget_id).run();
      row.spent_ai_calls = 0;
    }
    if (row.max_ai_calls !== null && Number(row.spent_ai_calls || 0) >= Number(row.max_ai_calls)) return false;
    await env.DB.prepare("UPDATE workflow_budgets SET spent_ai_calls=spent_ai_calls+1,updated_at=? WHERE budget_id=?")
      .bind(new Date().toISOString(), row.budget_id).run();
    return true;
  } catch {
    return true;
  }
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/i)?.[1];
  if (fenced) {
    try { return JSON.parse(fenced); } catch {}
  }
  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    try { return JSON.parse(trimmed.slice(objectStart, objectEnd + 1)); } catch {}
  }
  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    try { return JSON.parse(trimmed.slice(arrayStart, arrayEnd + 1)); } catch {}
  }
  throw new Error("ai_invalid_json");
}

export async function aiJson<T>(
  env: Env,
  system: string,
  prompt: string,
  fallback: T,
  maxTokens = 1400
): Promise<T> {
  if (!env.AI) return fallback;
  const workflow = workflowFor(system);
  if (!(await takeAiBudget(env, workflow))) return fallback;
  try {
    const ai = env.AI as any;
    const config = cfg(env);
    const complexity = prompt.length + system.length + maxTokens * 4;
    const model = complexity >= 18_000 ? config.aiStrongModel : config.aiModel;
    const result = await ai.run(model, {
      messages: [
        {
          role: "system",
          content: system + "\nReturn valid JSON only. Never invent facts, companies, statistics, sources or URLs. If evidence is insufficient, say so in the JSON."
        },
        { role: "user", content: prompt }
      ],
      temperature: 0.1,
      max_tokens: maxTokens,
      response_format: { type: "json_object" }
    });
    const text =
      typeof result === "string" ? result :
      typeof result?.response === "string" ? result.response :
      typeof result?.result?.response === "string" ? result.result.response :
      JSON.stringify(result);
    return extractJson(text) as T;
  } catch {
    return fallback;
  }
}

export function evidencePrompt(items: Array<{ title?: string; url: string; snippet: string }>, maxChars = 24_000): string {
  let out = "";
  for (const [index, item] of items.entries()) {
    const next = `SOURCE ${index + 1}\nURL: ${item.url}\nTITLE: ${item.title || ""}\nTEXT: ${item.snippet}\n\n`;
    if ((out + next).length > maxChars) break;
    out += next;
  }
  return out;
}
