-- Adapta whatsapp_lines para soportar líneas de tipo 'cloud' (WhatsApp Cloud API).
-- Las líneas cloud no tienen instancia Evolution ni URL, por lo que ambos campos
-- deben ser nullable. line_key se amplía a 50 chars para acomodar el prefijo 'cloud_'.

ALTER TABLE whatsapp_lines ALTER COLUMN evolution_instance DROP NOT NULL;
ALTER TABLE whatsapp_lines ALTER COLUMN evolution_url      DROP NOT NULL;
ALTER TABLE whatsapp_lines ALTER COLUMN line_key           TYPE VARCHAR(50);
