PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS attribution_snapshots (
  attribution_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  opportunity_id TEXT,
  model TEXT NOT NULL,
  result_json TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(opportunity_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS voice_patterns (
  pattern_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  segment TEXT,
  pattern_type TEXT NOT NULL,
  phrase TEXT NOT NULL,
  frequency INTEGER NOT NULL DEFAULT 1,
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  publication_safe INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS battlecards (
  battlecard_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  competitor_id TEXT NOT NULL,
  account_id TEXT,
  content_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  confidence INTEGER NOT NULL DEFAULT 50,
  generated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id, competitor_id, account_id),
  FOREIGN KEY (competitor_id) REFERENCES competitors(competitor_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS opportunity_products (
  opportunity_id TEXT NOT NULL,
  product_code TEXT NOT NULL,
  fit_score INTEGER NOT NULL DEFAULT 50,
  rationale TEXT NOT NULL,
  selected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (opportunity_id, product_code),
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(opportunity_id) ON DELETE CASCADE,
  FOREIGN KEY (product_code) REFERENCES commercial_products(product_code)
);

CREATE TABLE IF NOT EXISTS trigger_predictions (
  prediction_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  account_id TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  confidence INTEGER NOT NULL DEFAULT 50,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'hypothesis',
  predicted_window TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS self_service_orders (
  order_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  account_id TEXT,
  email TEXT NOT NULL,
  product_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  amount REAL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  billing_external_id TEXT,
  research_job_id TEXT,
  delivery_document_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE SET NULL,
  FOREIGN KEY (product_code) REFERENCES commercial_products(product_code),
  FOREIGN KEY (delivery_document_id) REFERENCES commercial_documents(document_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS partner_portal_tokens (
  token_id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  FOREIGN KEY (partner_id) REFERENCES partner_candidates(partner_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  credit_event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  client_id TEXT,
  account_id TEXT,
  event_type TEXT NOT NULL,
  credits INTEGER NOT NULL,
  capability TEXT,
  reference_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (client_id) REFERENCES api_clients(client_id) ON DELETE SET NULL,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS churn_reviews (
  churn_review_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  account_id TEXT NOT NULL,
  opportunity_id TEXT,
  primary_reason TEXT NOT NULL,
  contributing_factors_json TEXT NOT NULL DEFAULT '[]',
  preventability TEXT,
  qualification_lessons_json TEXT NOT NULL DEFAULT '[]',
  delivery_lessons_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE CASCADE,
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(opportunity_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS evidence_quality (
  quality_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  evidence_type TEXT NOT NULL,
  freshness_score INTEGER NOT NULL DEFAULT 50,
  source_quality_score INTEGER NOT NULL DEFAULT 50,
  corroboration_score INTEGER NOT NULL DEFAULT 50,
  contradiction_count INTEGER NOT NULL DEFAULT 0,
  overall_confidence INTEGER NOT NULL DEFAULT 50,
  details_json TEXT NOT NULL DEFAULT '{}',
  scored_at TEXT NOT NULL,
  UNIQUE(tenant_id, entity_type, entity_id, evidence_type)
);

CREATE TABLE IF NOT EXISTS provider_sync_state (
  sync_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  provider TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  cursor TEXT,
  last_synced_at TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  details_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id, provider, resource_type)
);

CREATE INDEX IF NOT EXISTS idx_attribution_opportunity_model ON attribution_snapshots(opportunity_id, model);
CREATE INDEX IF NOT EXISTS idx_voice_patterns_type ON voice_patterns(pattern_type, frequency DESC);
CREATE INDEX IF NOT EXISTS idx_predictions_account ON trigger_predictions(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON self_service_orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credits_client ON credit_ledger(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_churn_account ON churn_reviews(account_id, created_at DESC);
