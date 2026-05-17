-- Adapta whatsapp_lines para soportar líneas de tipo 'cloud' (WhatsApp Cloud API).
-- v_line_status depende de whatsapp_lines, por lo que hay que recrearla tras el ALTER.

DROP VIEW IF EXISTS v_line_status;

ALTER TABLE whatsapp_lines ALTER COLUMN evolution_instance DROP NOT NULL;
ALTER TABLE whatsapp_lines ALTER COLUMN evolution_url      DROP NOT NULL;
ALTER TABLE whatsapp_lines ALTER COLUMN line_key           TYPE VARCHAR(50);

CREATE OR REPLACE VIEW v_line_status AS
SELECT l.id,
    l.line_key,
    l.display_name,
    l.phone_number,
    l.evolution_instance,
    l.status,
    l.is_connected,
    l.last_seen_at,
    l.priority,
    l.assigned_region,
    l.msg_per_hour,
    l.msg_per_day,
    l.msgs_sent_hour,
    l.msgs_sent_today,
    round(((100.0 * (l.msgs_sent_hour)::numeric) / (NULLIF(l.msg_per_hour, 0))::numeric), 1) AS hour_capacity_pct,
    round(((100.0 * (l.msgs_sent_today)::numeric) / (NULLIF(l.msg_per_day, 0))::numeric), 1) AS day_capacity_pct,
    (l.msg_per_hour - l.msgs_sent_hour) AS remaining_hour,
    (l.msg_per_day - l.msgs_sent_today) AS remaining_day,
    lm.msgs_sent AS today_sent,
    lm.msgs_failed AS today_failed,
    lm.error_rate AS today_error_rate
FROM (whatsapp_lines l
    LEFT JOIN line_metrics lm ON ((l.id = lm.line_id) AND (lm.metric_date = CURRENT_DATE)));
