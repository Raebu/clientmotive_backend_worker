import type { Env, ScoreBreakdown } from "../types";
import type { LeadRow } from "../db";
import { id, isoNow } from "../lib/ids";

async function record(env: Env, leadId: string, channel: string, status: string, providerId: string | null, error: string | null) {
  await env.DB.prepare(
    "INSERT INTO notifications (notification_id, lead_id, channel, status, provider_id, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(id("note"), leadId, channel, status, providerId, error, isoNow()).run();
}

export async function notifyLeadReady(
  env: Env,
  lead: LeadRow,
  score: ScoreBreakdown,
  executiveSummary: string
): Promise<void> {
  const subject = `ClientMotive ${score.tier}-tier lead: ${lead.company} (${score.overall}/100)`;
  const text = [
    subject,
    "",
    executiveSummary,
    "",
    "Contact: " + lead.name + " <" + lead.email + ">",
    "Website: " + (lead.website || lead.domain || "not supplied"),
    "Lead ID: " + lead.lead_id
  ].join("\n");

  if (env.RESEND_API_KEY && env.ALERT_EMAIL_TO) {
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: "Bearer " + env.RESEND_API_KEY,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          from: env.ALERT_EMAIL_FROM || "ClientMotive Intelligence <clientmotive@clientmotive.com>",
          to: [env.ALERT_EMAIL_TO],
          reply_to: lead.email,
          subject,
          text
        })
      });
      const body = await response.json().catch(() => ({})) as { id?: string };
      await record(env, lead.lead_id, "email", response.ok ? "sent" : "failed", body.id || null, response.ok ? null : "resend_" + response.status);
    } catch (error) {
      await record(env, lead.lead_id, "email", "failed", null, String(error).slice(0, 500));
    }
  }

  if (env.SLACK_WEBHOOK_URL && score.tier === "A") {
    try {
      const response = await fetch(env.SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `*${subject}*\n${executiveSummary}\n${lead.name} — ${lead.email}\nLead ID: ${lead.lead_id}`
        })
      });
      await record(env, lead.lead_id, "slack", response.ok ? "sent" : "failed", null, response.ok ? null : "slack_" + response.status);
    } catch (error) {
      await record(env, lead.lead_id, "slack", "failed", null, String(error).slice(0, 500));
    }
  }
}
