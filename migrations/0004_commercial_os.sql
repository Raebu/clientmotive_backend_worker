PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS commercial_accounts (
  account_id TEXT PRIMARY KEY,
  lead_id TEXT,
  name TEXT NOT NULL,
  domain TEXT,
  segment TEXT,
  lifecycle_stage TEXT NOT NULL DEFAULT 'prospect',
  tier INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT,
  owner TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS commercial_signals (
  signal_id TEXT PRIMARY KEY,
  account_id TEXT,
  signal_type TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  source_url TEXT,
  confidence INTEGER NOT NULL DEFAULT 50,
  occurred_at TEXT,
  captured_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS watchlists (
  watchlist_id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT,
  subject_type TEXT NOT NULL,
  subject_value TEXT NOT NULL,
  signal_types_json TEXT NOT NULL DEFAULT '[]',
  cadence TEXT NOT NULL DEFAULT 'weekly',
  next_check_at TEXT NOT NULL,
  last_checked_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  consent_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS diagnostics (
  diagnostic_id TEXT PRIMARY KEY,
  diagnostic_type TEXT NOT NULL,
  visitor_id TEXT,
  lead_id TEXT,
  answers_json TEXT NOT NULL,
  score INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  public_token_hash TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS commercial_products (
  product_code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  revenue_model TEXT NOT NULL,
  delivery_mode TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  product_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  cadence TEXT NOT NULL DEFAULT 'monthly',
  started_at TEXT NOT NULL,
  renews_at TEXT,
  ended_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE CASCADE,
  FOREIGN KEY (product_code) REFERENCES commercial_products(product_code)
);

CREATE TABLE IF NOT EXISTS opportunities (
  opportunity_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  lead_id TEXT,
  name TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'identified',
  value_estimate REAL,
  probability INTEGER NOT NULL DEFAULT 10,
  source TEXT,
  current_problem TEXT,
  next_action TEXT,
  next_action_at TEXT,
  last_activity_at TEXT,
  owner TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE CASCADE,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS opportunity_outcomes (
  outcome_id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL,
  outcome_type TEXT NOT NULL,
  value REAL,
  reason TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(opportunity_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS objections (
  objection_id TEXT PRIMARY KEY,
  opportunity_id TEXT,
  lead_id TEXT,
  category TEXT NOT NULL,
  objection_text TEXT NOT NULL,
  buyer_role TEXT,
  segment TEXT,
  message_variant TEXT,
  response_text TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(opportunity_id) ON DELETE CASCADE,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS commercial_experiments (
  experiment_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dimension TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  variant_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS experiment_results (
  result_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  account_id TEXT,
  opportunity_id TEXT,
  variant TEXT,
  metric TEXT NOT NULL,
  numeric_value REAL,
  outcome TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (experiment_id) REFERENCES commercial_experiments(experiment_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE SET NULL,
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(opportunity_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS relationships (
  relationship_id TEXT PRIMARY KEY,
  from_type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relationship_type TEXT NOT NULL,
  strength INTEGER NOT NULL DEFAULT 50,
  source_url TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS referrals (
  referral_id TEXT PRIMARY KEY,
  referrer_type TEXT NOT NULL,
  referrer_id TEXT NOT NULL,
  referred_account_id TEXT,
  referred_name TEXT,
  referral_code TEXT,
  status TEXT NOT NULL DEFAULT 'introduced',
  attributed_value REAL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (referred_account_id) REFERENCES commercial_accounts(account_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS partner_candidates (
  partner_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  website TEXT,
  partner_type TEXT NOT NULL,
  fit_score INTEGER NOT NULL DEFAULT 50,
  rationale TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'candidate',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commercial_documents (
  document_id TEXT PRIMARY KEY,
  lead_id TEXT,
  opportunity_id TEXT,
  document_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE SET NULL,
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(opportunity_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS meetings (
  meeting_id TEXT PRIMARY KEY,
  opportunity_id TEXT,
  lead_id TEXT,
  scheduled_at TEXT,
  attendees_json TEXT NOT NULL DEFAULT '[]',
  notes_text TEXT,
  transcript_text TEXT,
  brief_json TEXT,
  followup_json TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(opportunity_id) ON DELETE SET NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS nurture_enrollments (
  enrollment_id TEXT PRIMARY KEY,
  lead_id TEXT,
  account_id TEXT,
  problem_category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  next_touch_at TEXT,
  last_touch_at TEXT,
  content_json TEXT NOT NULL DEFAULT '[]',
  consent_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE SET NULL,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS content_insights (
  insight_id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT,
  audience TEXT,
  topic TEXT NOT NULL,
  problem TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  demand_type TEXT NOT NULL DEFAULT 'qualitative',
  priority INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_assets (
  asset_id TEXT PRIMARY KEY,
  asset_type TEXT NOT NULL,
  audience TEXT,
  title TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  published_url TEXT,
  source_insights_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_health (
  account_id TEXT PRIMARY KEY,
  health_score INTEGER NOT NULL DEFAULT 50,
  renewal_risk INTEGER NOT NULL DEFAULT 50,
  expansion_score INTEGER NOT NULL DEFAULT 50,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  scored_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS routing_destinations (
  destination_code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  categories_json TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS routing_suggestions (
  suggestion_id TEXT PRIMARY KEY,
  lead_id TEXT,
  account_id TEXT,
  destination_code TEXT NOT NULL,
  need_category TEXT NOT NULL,
  rationale TEXT NOT NULL,
  confidence INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'suggested',
  created_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE SET NULL,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE SET NULL,
  FOREIGN KEY (destination_code) REFERENCES routing_destinations(destination_code)
);

CREATE TABLE IF NOT EXISTS industry_playbooks (
  industry_slug TEXT PRIMARY KEY,
  industry_name TEXT NOT NULL,
  playbook_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  generated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS benchmark_reports (
  benchmark_id TEXT PRIMARY KEY,
  benchmark_type TEXT NOT NULL,
  segment TEXT,
  sample_size INTEGER NOT NULL DEFAULT 0,
  report_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  generated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_nodes (
  node_id TEXT PRIMARY KEY,
  node_type TEXT NOT NULL,
  canonical_key TEXT NOT NULL,
  label TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(node_type, canonical_key)
);

CREATE TABLE IF NOT EXISTS knowledge_edges (
  edge_id TEXT PRIMARY KEY,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 50,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(from_node_id, to_node_id, edge_type),
  FOREIGN KEY (from_node_id) REFERENCES knowledge_nodes(node_id) ON DELETE CASCADE,
  FOREIGN KEY (to_node_id) REFERENCES knowledge_nodes(node_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS api_clients (
  client_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  monthly_limit INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS api_usage (
  usage_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 1,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (client_id) REFERENCES api_clients(client_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_accounts_domain ON commercial_accounts(domain);
CREATE INDEX IF NOT EXISTS idx_accounts_stage_tier ON commercial_accounts(lifecycle_stage, tier);
CREATE INDEX IF NOT EXISTS idx_signals_account_time ON commercial_signals(account_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_type_time ON commercial_signals(signal_type, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_watchlists_due ON watchlists(status, next_check_at);
CREATE INDEX IF NOT EXISTS idx_opportunities_stage_action ON opportunities(stage, next_action_at);
CREATE INDEX IF NOT EXISTS idx_outcomes_type_time ON opportunity_outcomes(outcome_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_objections_category ON objections(category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_priority ON content_insights(status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_usage_client_time ON api_usage(client_id, occurred_at DESC);

INSERT OR IGNORE INTO commercial_products (
  product_code, name, category, description, revenue_model, delivery_mode, active, metadata_json, created_at, updated_at
) VALUES
  ('growth_snapshot', 'ClientMotive Growth Snapshot', 'free', 'Prospect-facing market, buyer and channel snapshot.', 'lead_generation', 'automated', 1, '{}', datetime('now'), datetime('now')),
  ('icp_sprint', 'ICP & Buyer Intelligence Sprint', 'entry', 'Evidence-led ICP, buyer committee and target-account definition.', 'fixed_fee', 'hybrid', 1, '{}', datetime('now'), datetime('now')),
  ('competitive_sprint', 'Competitive Positioning Sprint', 'entry', 'Competitive landscape, positioning gaps and messaging opportunities.', 'fixed_fee', 'hybrid', 1, '{}', datetime('now'), datetime('now')),
  ('outbound_audit', 'Outbound Readiness Audit', 'entry', 'Audit of market definition, buyer roles, infrastructure, messaging, CRM and follow-up.', 'fixed_fee', 'hybrid', 1, '{}', datetime('now'), datetime('now')),
  ('campaign_architecture', 'Campaign Architecture', 'entry', 'Research, target accounts, triggers, messaging and sequence architecture for client-run execution.', 'fixed_fee', 'hybrid', 1, '{}', datetime('now'), datetime('now')),
  ('managed_outreach', 'ClientMotive Managed', 'core', 'Managed research-led B2B outreach and iteration.', 'monthly_or_project', 'managed', 1, '{}', datetime('now'), datetime('now')),
  ('market_intelligence', 'ClientMotive Intelligence', 'recurring', 'Continuous market, account, competitor, buyer-change and trigger intelligence.', 'subscription', 'managed', 1, '{}', datetime('now'), datetime('now')),
  ('gtm_premium', 'GTM Intelligence + Managed Execution', 'premium', 'Continuous intelligence, strategy and managed commercial execution.', 'retainer', 'managed', 1, '{}', datetime('now'), datetime('now')),
  ('white_label_api', 'ClientMotive Intelligence API', 'later', 'Controlled research and prioritisation capabilities for partners and agencies.', 'usage', 'api', 0, '{}', datetime('now'), datetime('now'));
