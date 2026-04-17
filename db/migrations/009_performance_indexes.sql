-- Fix 7: Missing performance indexes

-- Outbound phone lookup (webhook fallback)
CREATE INDEX IF NOT EXISTS idx_messages_outbound_phone
  ON whatsapp_messages (phone_number, sent_at DESC)
  WHERE direction = 'outbound';

-- Campaign + contact lookup
CREATE INDEX IF NOT EXISTS idx_messages_campaign_contact
  ON whatsapp_messages (campaign_id, contact_id);

-- Contacts filters
CREATE INDEX IF NOT EXISTS idx_contacts_panel   ON contacts(panel)   WHERE panel   IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_gaming  ON contacts(gaming)  WHERE gaming  IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_linea   ON contacts(linea)   WHERE linea   IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_status  ON contacts(status);

-- contact_list_members
CREATE UNIQUE INDEX IF NOT EXISTS idx_clm_unique  ON contact_list_members(list_id, contact_id);
CREATE INDEX        IF NOT EXISTS idx_clm_contact ON contact_list_members(contact_id, list_id);
