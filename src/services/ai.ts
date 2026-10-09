import type { Env } from "../types";
import { cfg } from "../config";

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
  try {
    const ai = env.AI as any;
    const result = await ai.run(cfg(env).aiModel, {
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
