ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS template_id     UUID REFERENCES whatsapp_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS template_params JSONB DEFAULT '{}'::jsonb;
