-- Preserve existing templates; only templates verified for a WABA may use Cloud campaigns.
ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS waba_id TEXT;
ALTER TABLE whatsapp_templates DROP CONSTRAINT IF EXISTS whatsapp_templates_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_templates_waba_name_language
  ON whatsapp_templates(waba_id,name,language) WHERE waba_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_templates_legacy_name
  ON whatsapp_templates(name) WHERE waba_id IS NULL;
CREATE INDEX IF NOT EXISTS campaigns_scheduled_due
  ON campaigns(scheduled_at) WHERE status = 'scheduled';
