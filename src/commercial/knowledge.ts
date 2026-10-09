import type { Env } from "../types";
import { id, isoNow } from "../lib/ids";

export async function upsertKnowledgeNode(
  env: Env,
  nodeType: string,
  canonicalKey: string,
  label: string,
  data: Record<string, unknown> = {}
): Promise<string> {
  const existing = await env.DB.prepare(
    "SELECT node_id FROM knowledge_nodes WHERE node_type = ? AND canonical_key = ? LIMIT 1"
  ).bind(nodeType, canonicalKey).first<{ node_id: string }>();
  const now = isoNow();
  if (existing) {
    await env.DB.prepare(
      "UPDATE knowledge_nodes SET label = ?, data_json = ?, updated_at = ? WHERE node_id = ?"
    ).bind(label, JSON.stringify(data), now, existing.node_id).run();
    return existing.node_id;
  }
  const nodeId = id("node");
  await env.DB.prepare(
    "INSERT INTO knowledge_nodes (node_id, node_type, canonical_key, label, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(nodeId, nodeType, canonicalKey, label, JSON.stringify(data), now, now).run();
  return nodeId;
}

export async function upsertKnowledgeEdge(
  env: Env,
  fromNodeId: string,
  toNodeId: string,
  edgeType: string,
  weight = 50,
  evidence: string[] = []
): Promise<string> {
  const existing = await env.DB.prepare(
    "SELECT edge_id FROM knowledge_edges WHERE from_node_id = ? AND to_node_id = ? AND edge_type = ? LIMIT 1"
  ).bind(fromNodeId, toNodeId, edgeType).first<{ edge_id: string }>();
  const now = isoNow();
  if (existing) {
    await env.DB.prepare(
      "UPDATE knowledge_edges SET weight = ?, evidence_json = ?, updated_at = ? WHERE edge_id = ?"
    ).bind(weight, JSON.stringify(evidence), now, existing.edge_id).run();
    return existing.edge_id;
  }
  const edgeId = id("edge");
  await env.DB.prepare(
    "INSERT INTO knowledge_edges (edge_id, from_node_id, to_node_id, edge_type, weight, evidence_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(edgeId, fromNodeId, toNodeId, edgeType, weight, JSON.stringify(evidence), now, now).run();
  return edgeId;
}

export async function connectEntities(
  env: Env,
  from: { type: string; key: string; label: string },
  to: { type: string; key: string; label: string },
  edgeType: string,
  evidence: string[] = [],
  weight = 50
): Promise<void> {
  const [fromId, toId] = await Promise.all([
    upsertKnowledgeNode(env, from.type, from.key, from.label),
    upsertKnowledgeNode(env, to.type, to.key, to.label)
  ]);
  await upsertKnowledgeEdge(env, fromId, toId, edgeType, weight, evidence);
}

export async function graphAround(env: Env, nodeType: string, canonicalKey: string, limit = 50): Promise<Record<string, unknown>> {
  const node = await env.DB.prepare(
    "SELECT * FROM knowledge_nodes WHERE node_type = ? AND canonical_key = ? LIMIT 1"
  ).bind(nodeType, canonicalKey).first<any>();
  if (!node) return { node: null, edges: [], nodes: [] };
  const edges = await env.DB.prepare(
    "SELECT * FROM knowledge_edges WHERE from_node_id = ? OR to_node_id = ? ORDER BY weight DESC LIMIT ?"
  ).bind(node.node_id, node.node_id, Math.max(1, Math.min(200, limit))).all<any>();
  const nodeIds = [...new Set(edges.results.flatMap((edge) => [edge.from_node_id, edge.to_node_id]))];
  if (!nodeIds.length) return { node, edges: [], nodes: [] };
  const placeholders = nodeIds.map(() => "?").join(",");
  const nodes = await env.DB.prepare(
    `SELECT * FROM knowledge_nodes WHERE node_id IN (${placeholders})`
  ).bind(...nodeIds).all<any>();
  return { node, edges: edges.results, nodes: nodes.results };
}
