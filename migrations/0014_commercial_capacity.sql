ALTER TABLE leads ADD COLUMN entity_type TEXT NOT NULL DEFAULT 'company';

CREATE TABLE IF NOT EXISTS commercial_capacity_profiles (
  lead_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  employee_band TEXT NOT NULL,
  revenue_band TEXT NOT NULL,
  funding_band TEXT NOT NULL,
  procurement_complexity TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  recommended_offer TEXT NOT NULL,
  price_floor_gbp INTEGER NOT NULL,
  target_price_gbp INTEGER NOT NULL,
  price_ceiling_gbp INTEGER NOT NULL,
  pricing_rationale_json TEXT NOT NULL DEFAULT '[]',
  evidence_urls_json TEXT NOT NULL DEFAULT '[]',
  generated_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_capacity_offer
  ON commercial_capacity_profiles(recommended_offer, confidence DESC);
