-- Migration 036: Permisos avanzados por usuario
-- can_download_contacts: permite o bloquea la descarga de contactos
-- allowed_agents: restricción de acceso por agente/casino (vacío = sin restricción)

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS can_download_contacts BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allowed_agents TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN users.can_download_contacts IS 'Si false, el usuario no puede descargar contactos en Excel/CSV';
COMMENT ON COLUMN users.allowed_agents IS 'Lista de agentes/casinos permitidos. Vacío = sin restricción. Ej: {royal,bigwin}';
