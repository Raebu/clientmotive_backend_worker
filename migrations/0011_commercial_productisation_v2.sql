PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS commercial_scorecards (
  scorecard_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  lead_id TEXT,
  account_id TEXT,
  scorecard_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  generated_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS commercial_recommendations (
  recommendation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  lead_id TEXT,
  account_id TEXT,
  opportunity_id TEXT,
  category TEXT NOT NULL,
  recommendation_text TEXT NOT NULL,
  rationale TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  confidence INTEGER NOT NULL DEFAULT 50,
  priority TEXT NOT NULL DEFAULT 'next',
  owner TEXT,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'recommended',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE SET NULL,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE CASCADE,
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(opportunity_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS recommendation_outcomes (
  outcome_id TEXT PRIMARY KEY,
  recommendation_id TEXT NOT NULL,
  outcome_type TEXT NOT NULL,
  numeric_value REAL,
  details_json TEXT NOT NULL DEFAULT '{}',
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (recommendation_id) REFERENCES commercial_recommendations(recommendation_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS first_party_ingestions (
  ingestion_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  account_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  period_start TEXT,
  period_end TEXT,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  dimensions_json TEXT NOT NULL DEFAULT '{}',
  provenance_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'accepted',
  ingested_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS intelligence_change_events (
  change_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  account_id TEXT,
  domain TEXT NOT NULL,
  change_type TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  confidence INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'new',
  detected_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_scorecards_lead_time ON commercial_scorecards(lead_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_recommendations_account_status ON commercial_recommendations(account_id, status, priority);
CREATE INDEX IF NOT EXISTS idx_recommendations_lead_status ON commercial_recommendations(lead_id, status, priority);
CREATE INDEX IF NOT EXISTS idx_recommendation_outcomes_rec ON recommendation_outcomes(recommendation_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_first_party_account_source ON first_party_ingestions(account_id, source_type, ingested_at DESC);
CREATE INDEX IF NOT EXISTS idx_intelligence_changes_account_time ON intelligence_change_events(account_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_intelligence_changes_domain_time ON intelligence_change_events(domain, detected_at DESC);

UPDATE commercial_products
SET name='ClientMotive Growth Snapshot',
    category='entry',
    description='Executive commercial intelligence review covering company, market, competitors, marketing, ICP, buyers, signals, opportunity, risk and a 90-day action plan.',
    revenue_model='fixed_fee',
    delivery_mode='hybrid',
    metadata_json='{"publicOffer":true,"indicativeFrom":1500,"indicativeTo":3000,"currency":"GBP","position":"entry"}',
    updated_at=datetime('now')
WHERE product_code='growth_snapshot';

UPDATE commercial_products
SET name='ClientMotive Growth Intelligence',
    category='recurring',
    description='Continuous competitor, account, signal and marketing intelligence with executive recommendations and change alerts.',
    revenue_model='subscription',
    delivery_mode='managed',
    metadata_json='{"publicOffer":true,"indicativeFrom":3000,"indicativeTo":7500,"currency":"GBP","cadence":"monthly","position":"core"}',
    updated_at=datetime('now')
WHERE product_code='market_intelligence';

UPDATE commercial_products
SET name='ClientMotive Managed Growth',
    category='premium',
    description='Continuous intelligence plus managed campaigns, outreach, CRM/automation, content, GTM execution and optimisation.',
    revenue_model='retainer',
    delivery_mode='managed',
    metadata_json='{"publicOffer":true,"indicativeFrom":7500,"indicativeTo":20000,"currency":"GBP","cadence":"monthly","position":"premium"}',
    updated_at=datetime('now')
WHERE product_code='gtm_premium';

UPDATE commercial_products
SET metadata_json='{"publicOffer":false}'
WHERE product_code IN ('icp_sprint','competitive_sprint','outbound_audit','campaign_architecture','managed_outreach','white_label_api');
