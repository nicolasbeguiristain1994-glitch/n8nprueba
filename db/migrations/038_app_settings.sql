CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB        NOT NULL,
  type        TEXT         NOT NULL DEFAULT 'string',
  description TEXT,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_by  UUID         REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO app_settings (key, value, type, description) VALUES
  ('general_timezone',           '"America/Argentina/Buenos_Aires"',                       'string',  'Zona horaria por defecto del sistema'),
  ('general_date_format',        '"DD/MM/YYYY HH:mm"',                                    'string',  'Formato de fecha/hora en la UI'),
  ('general_rows_per_page',      '50',                                                    'number',  'Filas por página en tablas'),
  ('general_env_name',           '"Producción"',                                          'string',  'Nombre visible del entorno'),
  ('contacts_export_format',     '"csv"',                                                 'string',  'Formato de exportación por defecto'),
  ('contacts_max_bulk_select',   '10000',                                                 'number',  'Límite máximo de selección masiva de contactos'),
  ('contacts_phone_normalize',   'true',                                                  'boolean', 'Normalización automática de teléfonos al importar'),
  ('casino_enabled_agents',      '["betcoin","bigwin","farabet","ofizeus","royal"]',       'json',    'Agentes de casino habilitados en el dashboard'),
  ('casino_default_agent',       '"__all__"',                                             'string',  'Agente por defecto en el dashboard casino'),
  ('casino_default_time_mode',   '"local"',                                               'string',  'Modo horario por defecto: local o utc'),
  ('casino_risk_inactive_min',   '31',                                                    'number',  'Días inactivo mínimo para considerar jugador en riesgo'),
  ('casino_risk_inactive_max',   '60',                                                    'number',  'Días inactivo máximo para considerar jugador en riesgo'),
  ('limits_max_lines',           '100',                                                   'number',  'Número máximo de líneas WhatsApp en el pool'),
  ('limits_max_warmup_lines',    '20',                                                    'number',  'Número máximo de líneas en calentamiento activas'),
  ('perms_contacts_export_global','true',                                                 'boolean', 'Habilitar descarga de contactos a nivel global del sistema'),
  ('perms_zeus_sync_global',     'true',                                                  'boolean', 'Habilitar sincronización con Zeus a nivel global')
ON CONFLICT (key) DO NOTHING;
