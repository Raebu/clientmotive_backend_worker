import type { Env, ResearchMessage } from "./types";
import { cfg } from "./config";
import { route } from "./router";
import { processResearchMessage } from "./services/research";
import { runDailyCommercialAutomation } from "./commercial/automation";
import { runRevenueOperationsAutomation } from "./ops/automation";

async function cleanup(env: Env): Promise<void> {
  const days = cfg(env).retentionDays;
  const modifier = "-" + days + " days";
  await env.DB.batch([
    env.DB.prepare("DELETE FROM visitor_events WHERE occurred_at < datetime('now', ?)").bind(modifier),
    env.DB.prepare("DELETE FROM visitor_sessions WHERE last_seen_at < datetime('now', ?) AND submitted_lead_id IS NULL").bind(modifier),
    env.DB.prepare("DELETE FROM audit_log WHERE created_at < datetime('now', '-365 days')")
  ]);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      console.error("unhandled_request_error", error);
      return new Response(JSON.stringify({ error: "Internal server error.", code: "internal_error" }), {
        status: 500,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff"
        }
      });
    }
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processResearchMessage(env, message.body as ResearchMessage);
        message.ack();
      } catch (error) {
        console.error("research_message_failed", message.body, error);
        message.retry();
      }
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      await cleanup(env);
    } catch (error) {
      console.error("retention_cleanup_failed", error);
    }
    try {
      const result = await runDailyCommercialAutomation(env);
      console.log("commercial_automation_complete", result);
    } catch (error) {
      console.error("commercial_automation_failed", error);
    }
    try {
      const result = await runRevenueOperationsAutomation(env);
      console.log("revenue_operations_automation_complete", result);
    } catch (error) {
      console.error("revenue_operations_automation_failed", error);
    }
  }
};
