# Convenciones del Proyecto

## Nombres de workflows en n8n

Formato: `[DOMINIO]_[ACCION]_[TRIGGER]`

Ejemplos:
- `ONBOARDING_bienvenida_nuevo_jugador`
- `RETENCION_inactivo_d7`
- `PAGOS_deposito_confirmado`
- `RISK_retiro_alto_umbral`
- `OPS_reporte_diario`

**Dominios disponibles:**
- `ONBOARDING` — flujos de registro y verificación
- `RETENCION` — comunicaciones de retención
- `PAGOS` — notificaciones de transacciones
- `SOPORTE` — atención al jugador
- `RISK` — alertas y controles
- `OPS` — operaciones internas y reportes

---

## Nombres de archivos JSON (workflow exports)

Formato: `DOMINIO_accion-trigger_v1.json`

Ejemplos:
- `ONBOARDING_bienvenida-nuevo-jugador_v1.json`
- `RETENCION_inactivo-d7_v2.json`

---

## Nombres de tablas en base de datos

- Snake case en minúsculas
- Plural
- Prefijo por módulo cuando aplica

Ejemplos:
- `players`
- `transactions`
- `whatsapp_messages`
- `whatsapp_templates`
- `risk_flags`
- `bonus_assignments`

---

## Nombres de migraciones

Formato: `YYYYMMDD_NNN_descripcion.sql`

Ejemplos:
- `20260401_001_initial_schema.sql`
- `20260410_002_add_risk_flags_table.sql`
- `20260415_003_add_player_segments.sql`

---

## Variables de entorno

- SCREAMING_SNAKE_CASE
- Prefijo por servicio: `SUPABASE_`, `EVOLUTION_`, `NOWPAYMENTS_`, `N8N_`

---

## Plantillas de mensajes

Archivo: `/src/templating/`
Formato de nombre: `[dominio]-[evento]-[variante].txt`

Ejemplos:
- `onboarding-bienvenida-default.txt`
- `retencion-inactivo-d7-oferta.txt`
- `pagos-deposito-confirmado.txt`

Variables dentro de plantillas: `{{nombre}}`, `{{monto}}`, `{{fecha}}`

---

## Branches de Git

- `main` — producción estable
- `dev` — desarrollo activo
- `feature/nombre-feature` — nuevas funcionalidades
- `fix/descripcion-bug` — correcciones
- `workflow/nombre-workflow` — desarrollo de workflow específico
