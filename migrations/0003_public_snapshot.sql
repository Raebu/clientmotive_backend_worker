ALTER TABLE leads ADD COLUMN public_token_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_public_token_hash ON leads(public_token_hash);
