# Documento de Funcionalidades — Plataforma de Automatización WhatsApp

**Fecha:** 2026-06-18  
**Stack:** Next.js 16 (App Router) + PostgreSQL (Supabase) + n8n + Evolution API + Redis  
**Propósito:** Orquestación de comunicaciones vía WhatsApp para operaciones de iGaming en LATAM  

---

## Índice

1. [Arquitectura general](#1-arquitectura-general)
2. [Módulos funcionales](#2-módulos-funcionales)
3. [API — Endpoints completos](#3-api--endpoints-completos)
4. [Base de datos — Entidades principales](#4-base-de-datos--entidades-principales)
5. [Servicios y lógica de negocio](#5-servicios-y-lógica-de-negocio)
6. [Integraciones externas](#6-integraciones-externas)
7. [Seguridad y acceso](#7-seguridad-y-acceso)

---

## 1. Arquitectura general

```
whatsapp-automation-platform/
├── frontend/               # Next.js 16 — UI + API routes
│   ├── app/(protected)/    # Rutas autenticadas (21 páginas)
│   ├── app/api/            # 150+ endpoints (App Router)
│   ├── components/         # ShadCN + componentes propios
│   ├── lib/                # Servicios, DB pool, lógica core
│   └── hooks/              # React hooks (SSE, conversaciones, warmup)
├── db/migrations/          # 119 migraciones SQL
├── src/casino-connectors/  # Factory + Strategy para Zeus/Bet30
├── scripts/                # 21 scripts operacionales
├── workflows/              # 6 specs n8n
└── n8n/                    # Configuración n8n self-hosted
```

| Capa | Tecnología |
|------|------------|
| Frontend | Next.js 16.2, React 19.2, TypeScript, Tailwind 4, ShadCN |
| Base de datos | PostgreSQL en Supabase, raw `pg` pool (sin ORM), 119 migraciones |
| Cache/Queue | Redis |
| Mensajería | Evolution API (self-hosted) + Meta WhatsApp Cloud API |
| Orquestación | n8n self-hosted (60+ workflows) |
| Auth | HMAC-SHA256 custom, sesiones 7 días |
| RBAC | Roles: admin / operator / viewer + 14 sectores granulares |
| Scraping | Playwright |
| Deploy | Railway (Docker/Nixpacks) |

---

## 2. Módulos funcionales

### 2.1 Dashboard (`/`)

Vista principal con métricas en tiempo real.

- Selector de plataforma: Zeus / Bet30 / Consolidado
- Widgets reordenables (drag-drop):
  - Jugadores activos, VIPs, en déficit, recuperables
  - Campañas enviadas hoy, tasas de entrega y lectura
  - Líneas elegibles, tasas horarias y diarias
  - Flags de riesgo activos, jugadores en watch list
  - Análisis de caja: entradas, salidas, balance
- Auto-refresh configurable (5–30 min)
- Rangos de fecha personalizables
- Botón "Sincronizar casino" → dispara sync manual
- Toast notifications en tiempo real

---

### 2.2 Contactos (`/contacts`)

Gestión de la base de datos de jugadores.

**Listado y búsqueda:**
- Tabla paginada (50–200 contactos por página)
- Búsqueda full-text por nombre, teléfono y email (índice trgm)
- Filtros: segmento, panel, tipo de juego, línea asignada, actividad
- Selección múltiple con acciones bulk: editar, etiquetar, descargar

**Crear / editar contacto:**
- Campos: teléfono (E.164), nombre, email, panel, gaming, línea, segmento
- Auto-detección de plataforma (Zeus / Bet30) por nombre

**Importación masiva:**
- Upload CSV/XLSX
- Preview de importación (válidos / inválidos / duplicados)
- Opción merge vs. reemplazo
- Progress bar con conteo total

**Etiquetado:**
- Tags automáticos desde sync de casino: `casino:actividad`, `casino:valor_riesgo`, `casino:antiguedad`
- Tags manuales personalizados
- Reemplazo atómico por familia de tags (sin duplicados)

**Exportación:**
- Formato CSV o VCF
- Exportación con filtros aplicados

**Priorización (LTV):**
- Cálculo de lifetime value (`ltv_score`) y segmento recomendado
- Broadcast de ofertas a contactos priorizados
- Batch recompute desde panel admin

---

### 2.3 Campañas (`/campaigns`)

Envío masivo de mensajes a contactos o prospectos.

**Listado:**
- Estados: draft | scheduled | running | paused | completed | cancelled
- Métricas en vivo: enviado / entregado / leído / fallido
- Lock visual si hay processor activo (`processor_locked_at`)

**Crear campaña:**
- Nombre, tipo (promotion | retention | payment | risk_alert | support | onboarding | survey)
- Audiencia: lista de contactos (`contact_lists`) o lista de prospectos (`prospect_lists`)
- Mensaje simple o secuencia multi-mensaje (JSONB)
- Media URL + tipo (text | media | template)
- Programación: fecha/hora de inicio
- Anti-ban: delay aleatorio configurable (min/max), personalización de nombre, multi-línea
- Perfil anti-ban selector (profiles precargados)

**Motor de envío:**
- Dispatcher procesa en batches con selección inteligente de línea
- Delay anti-block aleatorio entre mensajes
- Deduplicación en Redis
- Lock-based processing (previene duplicación concurrente)
- Respeto de reglas de frecuencia por contacto
- Webhook `/api/webhook/evolution` recibe status updates (sent / delivered / read / failed)

**Detalle de campaña:**
- Gráfico de distribución de estados (Recharts)
- Lista de contactos con estado por fila
- Retry de fallidos, reset de frecuencia, desbloqueo de processor

---

### 2.4 Conversaciones (`/conversations`)

Inbox bidireccional de mensajes WhatsApp.

**Listado:**
- Lista virtualizada con búsqueda por teléfono, nombre y texto
- Filtros: sin responder, archivadas, con tags, rango de fechas
- Badges: "respuesta pendiente", "SLA vencido"
- Actualización en tiempo real vía SSE (sin refresh)
- Contador: `N de M hilos · X sin responder`

**Conversación abierta:**
- Historial de mensajes (burbujas inbound / outbound)
- Info del contacto: foto, nombre, panel, segmento, tiempo de inactividad
- Envío de respuesta: textarea con Ctrl+Enter
- Emoji picker integrado
- Quick templates: respuestas predefinidas con un click
- Acciones: agregar nota interna, cambiar segmento, marcar como leída
- Blacklist desde conversación
- Validación de SLA

---

### 2.5 Líneas WhatsApp (`/lines`)

Pool de números WhatsApp con Evolution API o Meta Cloud API.

**Listado:**
- Estado de conexión (conectado / desconectado)
- Límites configurables: msgs/día, msgs/hora
- Tasas en vivo: enviados hoy vs. límite
- Tipo de línea: evolution | cloud
- Quality rating y messaging tier (Cloud API)

**Conexión Evolution (QR-based):**
- Generación de QR via API
- Polling de estado: idle → creating → qr → connecting → connected
- TTL de QR: 60 segundos con contador visual

**Conexión Cloud API (Meta):**
- Embedded signup flow (Facebook Login)
- Intercambio de código por tokens
- Sincronización de templates Meta
- Integración Chatwoot para soporte omnichannel

**Acciones por línea:**
- Editar: nombre, límites, prioridad, toggle de envío
- Desconectar / reconectar
- Ver detalle técnico (instancia, quality rating)
- Configurar webhooks Evolution

---

### 2.6 Calentamiento (`/warmup`)

Progresión automática de reputación de líneas WhatsApp desde 0 hasta máxima capacidad.

**Estrategia de progresión:**
- Curva: `f(x) = START + (MAX - START) × x^0.6`
- Día 1 → ~5 msgs/día · Día 7 → ~20 · Día 21 → ~63 · Día 30 → ~80
- Ajuste por reputation_score: >75 (acelera) / <40 (desacelera)
- Fases: foundation (días 1–7) | growth (días 7–21) | maturity (días 21+)
- Presets: conservadora | normal | agresiva

**Gestión de líneas de warmup:**
- Crear línea: nombre, teléfono, instancia, preset, target_days (7–30)
- Estados: active | paused | completed | banned
- Métricas: día actual, mensajes enviados hoy, total acumulado, límite diario
- Health score: entrega, quejas, calidad

**Pool de contactos:**
- 24+ contactos por línea para recibir mensajes
- Rotación para no repetir en menos de 48h
- Pausa de contacto si no responde

**Orquestación automática (n8n):**
- Cada 15 min: n8n llama al orchestrator para procesar envíos
- Plan calcula `daily_quota` por línea basado en reputation_score
- Distribución intra-día probabilística (más mensajes en horas pico)
- Reset diario a las 00:00 UTC

**Alertas y analítica:**
- Alertas predictivas: detecta caída de health antes de ban
- Efectividad: progreso real vs. proyectado
- Simulación: proyecta días necesarios para target
- Historial de actividad por línea

**Scripts de warmup:**
- CRUD de scripts personalizados de conversación
- Parser de scripts con validación

---

### 2.7 Tareas (`/tareas` y `/mis-tareas`)

Sistema de gestión de tareas operacionales.

**Tipos de tarea:**
- `difusion` — campaña masiva (referencia campaign_id, list_id)
- `envio_manual` — envío a contactos específicos
- `calentamiento` — calentar líneas específicas
- `atencion` — atender conversaciones pendientes
- `seguimiento` — seguimiento de contacto o campaña
- `revision` — revisar campaña o lista
- `otro` — libre

**Propiedades:**
- Nombre, descripción, tipo, prioridad (alta | media | baja)
- Estado: pendiente | en_progreso | completada | cancelada
- Asignación a usuario, fecha de vencimiento, fecha programada
- Soft delete con restauración

**Vistas:**
- `/tareas` (admin): todas las tareas del equipo
- `/mis-tareas` (operator): tareas asignadas al usuario actual
- Vista calendario: eventos por fecha
- Stats personales: asignadas, en progreso, completadas

---

### 2.8 Usuarios (`/users`) — Admin only

Gestión de accesos y permisos.

- Roles: admin | operator | viewer
- Sectores (14+): dashboard, contacts, campaigns, conversations, lines, warmup, tasks, estadisticas, automations, blacklist, templates, users, settings, send, lists
- Permisos adicionales: `can_download_contacts`, `allowed_agents`
- Cambio de contraseña desde panel
- Visibility rules: qué contactos puede ver cada operador

---

### 2.9 Settings (`/settings`) — Admin only

Configuración global de la plataforma.

- **Frequency Rules:** máximo N mensajes por contacto en período (día | semana | mes)
- **Segmentation Config:** umbrales de depósitos por tier (bajo | medio | vip | vip_medio | vip_alto | super_vip), criterios de antigüedad y actividad
- **Scoring Config:** pesos para `priority_score` (recencia, engagement, riesgo, LTV)
- **LTV Config:** parámetros de lifetime value y distribución de tiers
- **Audit Log:** historial de cambios (quién, qué, cuándo, valor anterior vs. nuevo)

---

### 2.10 Plantillas (`/templates`) — Admin only

Templates de mensajes WhatsApp.

- Variables dinámicas: `{{nombre}}`, `{{saldo}}`, etc.
- Dominios: onboarding | retention | payments | risk_alert | support
- Sincronización con Meta Cloud API
- Submission para aprobación de Meta
- Preview con datos de ejemplo
- Envío de test a número específico

---

### 2.11 Blacklist (`/blacklist`) — Admin only

Números bloqueados (opt-out, quejas, fraude).

- Agregar manual con razón y fuente
- Importación masiva CSV/XLSX
- Exportación completa
- Remoción con trazabilidad (quién removió y cuándo)
- Consulta automática en dispatcher antes de cada envío

---

### 2.12 Automatizaciones (`/automatizaciones`) — Admin only

Respuestas automáticas basadas en triggers de conversaciones.

**Tipos:**
- `reply` — respuesta automática simple
- `flow` — secuencia multi-turno
- `handoff` — derivación a humano (Chatwoot o manual)

**Triggers:**
- Palabra exacta (keyword)
- Contiene cadena (contains)
- Cualquier mensaje inbound (any_inbound)

**Características:**
- Prioridad de ejecución configurable
- Toggle activo / inactivo
- Log de ejecuciones para auditoría
- Prevención de loops (máx. 3 respuestas por conversación)

---

### 2.13 Estadísticas (`/estadisticas`) — Admin only

Analytics y reportería avanzada.

- Campañas: envíos, entrega, lectura, errores por período
- Líneas: distribución de mensajes, health trends
- Templates: performance por template
- Exportación masiva para BI externo

---

### 2.14 Prospectos y Prospect Lists

Gestión de leads antes de convertirse en contactos.

- Import desde CSV/XLSX con batch tracking
- Staging: lead | engaged | qualified | converted
- Conversión a `contact` con trazabilidad
- Prospect lists para usar como audiencia en campañas
- Bulk tagging y normalización de prefijos de teléfono

---

### 2.15 Prioridades (`/prioridades`)

Reactivación segmentada de jugadores inactivos.

Segmentos automáticos de reactivación:
- `REACTIVACION_URGENTE` — inactivos > 90 días, super_vip
- `REACTIVACION_PRIORITARIA` — inactivos > 60 días, vip
- `REACTIVACION_ESTANDAR` — inactivos > 30 días
- `REACTIVACION_FRIA_ALTO_VALOR` — alto LTV pero cold
- `REACTIVACION_FRIA` — bajo LTV, baja actividad

Acciones: recompute manual de scores, broadcast de oferta por segmento.

---

## 3. API — Endpoints completos

### Autenticación
| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/auth/login` | Credenciales → HMAC token |
| POST | `/api/auth/logout` | Invalidar sesión |
| GET | `/api/auth/me` | Usuario actual + permisos |

### Contactos
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/contacts` | Lista paginada con filtros |
| POST | `/api/contacts` | Crear contacto |
| GET | `/api/contacts/{id}` | Detalle |
| PATCH | `/api/contacts/{id}` | Editar |
| DELETE | `/api/contacts/{id}` | Eliminar |
| POST | `/api/contacts/import` | Bulk import |
| POST | `/api/contacts/import/check` | Preview antes de importar |
| GET | `/api/contacts/{id}/tags` | Ver tags |
| POST | `/api/contacts/{id}/tags` | Actualizar tags |
| GET | `/api/contacts/{id}/casino-stats` | Stats vinculadas al casino |
| POST | `/api/contacts/recompute-ltv` | Batch recompute LTV |
| POST | `/api/contacts/recompute-priorities` | Batch recompute priority scores |
| POST | `/api/contacts/recompute-platforms` | Detectar plataformas (Zeus/Bet30) |
| GET | `/api/contacts/ltv/distribution` | Distribución de LTV tiers |
| GET | `/api/contacts/ltv/last-success` | Último cálculo exitoso |
| POST | `/api/contacts/prioritized` | Listar contactos con prioridad |
| POST | `/api/contacts/prioritized/{id}/broadcast` | Enviar oferta a contacto |

### Campañas
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/campaigns` | Lista |
| POST | `/api/campaigns` | Crear |
| GET | `/api/campaigns/{id}` | Detalle |
| PATCH | `/api/campaigns/{id}` | Editar |
| DELETE | `/api/campaigns/{id}` | Cancelar |
| POST | `/api/campaigns/{id}/send` | Disparar envío |
| GET | `/api/campaigns/{id}/contacts` | Contactos en campaña |
| POST | `/api/campaigns/{id}/add-prospects` | Agregar prospectos |
| POST | `/api/campaigns/{id}/dispatch/process` | Background processor |
| POST | `/api/campaigns/{id}/retry-failed` | Reintentar fallidos |
| POST | `/api/campaigns/{id}/freq-reset` | Resetear frecuencia |
| POST | `/api/campaigns/{id}/force-unlock` | Desbloquear processor lock |
| POST | `/api/campaigns/{id}/sync-status` | Resincronizar estado |

### Conversaciones
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/conversations` | Lista paginada |
| GET | `/api/conversations/{phone}` | Detalle |
| POST | `/api/conversations/{phone}/send` | Enviar respuesta |
| POST | `/api/conversations/{phone}/notes` | Agregar nota interna |
| PATCH | `/api/conversations/{phone}/status` | Cambiar estado |
| POST | `/api/conversations/{phone}/blacklist` | Blacklist contacto |
| GET | `/api/conversations/stream` | SSE stream en vivo |

### Líneas WhatsApp
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/lines` | Lista con elegibilidad |
| POST | `/api/lines` | Crear línea |
| PATCH | `/api/lines` | Editar / toggle |
| DELETE | `/api/lines/{id}` | Eliminar |
| GET | `/api/lines/qr` | Generar QR Evolution |
| GET | `/api/lines/qr/status` | Poll status QR |
| GET | `/api/lines/health` | Health check global |
| POST | `/api/lines/grants` | Verificar permisos de usuario |
| POST | `/api/lines/configure-webhooks` | Setup webhooks Evolution |

### Cloud API (Meta)
| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/cloud/onboard` | Embedded signup flow |
| POST | `/api/cloud/onboard/verify` | Intercambiar código por tokens |
| GET | `/api/cloud/numbers` | Listar números registrados |
| POST | `/api/cloud/messages` | Enviar mensaje |
| GET | `/api/cloud/templates` | Listar templates Meta |
| POST | `/api/cloud/templates` | Crear template |
| GET | `/api/cloud/metrics` | Métricas Cloud API |
| POST | `/api/cloud/sync` | Sincronizar estado |
| POST | `/api/cloud/chatwoot-inbox` | Crear inbox en Chatwoot |
| POST | `/api/cloud/webhook` | Recibir webhooks Meta |

### Warmup
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/warmup` | Lista líneas warmup |
| POST | `/api/warmup` | Crear línea warmup |
| GET | `/api/warmup/{id}` | Detalle |
| PATCH | `/api/warmup/{id}` | Editar |
| DELETE | `/api/warmup/{id}` | Pausar |
| POST | `/api/warmup/{id}/reset` | Reiniciar desde día 1 |
| POST | `/api/warmup/{id}/migrate` | Migración de línea |
| GET | `/api/warmup/{id}/health` | Health detallado |
| GET | `/api/warmup/{id}/logs` | Activity logs |
| POST | `/api/warmup/schedule` | Calcular daily quota |
| GET | `/api/warmup/effectiveness` | Analítica de progreso |
| GET | `/api/warmup/alerts` | Alertas activas |
| POST | `/api/warmup/alerts/{id}/resolve` | Resolver alerta |
| GET | `/api/warmup/conversations` | Conversaciones de warmup |
| POST | `/api/warmup/conversations/process` | Procesar batch |
| GET | `/api/warmup/stream` | SSE updates en vivo |
| POST | `/api/warmup/daily-reset` | Reset diario |
| POST | `/api/warmup/orchestrator/plan` | Calcular plan diario |
| POST | `/api/warmup/orchestrator/run` | Ejecutar plan |
| GET | `/api/warmup/contacts` | Pool de contactos |
| POST | `/api/warmup/contacts` | Agregar contactos |
| POST | `/api/warmup/scripts` | CRUD scripts warmup |
| GET | `/api/warmup/simulator` | Simulación de progresión |

### Tareas
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/tasks` | Lista paginada |
| POST | `/api/tasks` | Crear |
| GET | `/api/tasks/{id}` | Detalle |
| PATCH | `/api/tasks/{id}` | Editar |
| DELETE | `/api/tasks/{id}` | Soft delete |
| POST | `/api/tasks/{id}/status` | Cambiar estado |
| POST | `/api/tasks/{id}/restore` | Restaurar |
| POST | `/api/tasks/bulk` | Bulk update |
| GET | `/api/tasks/my` | Tareas del usuario actual |
| GET | `/api/tasks/my/stats` | Stats personales |
| GET | `/api/tasks/calendar` | Eventos por fecha |

### Listas de contactos
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/lists` | Lista |
| POST | `/api/lists` | Crear |
| GET | `/api/lists/{id}` | Detalle |
| PATCH | `/api/lists/{id}` | Editar |
| DELETE | `/api/lists/{id}` | Eliminar |
| POST | `/api/lists/{id}/split` | Dividir lista en N partes |
| POST | `/api/lists/casino/repopulate` | Sincronizar con casino_players |

### Prospectos y Prospect Lists
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/prospects` | Lista |
| POST | `/api/prospects` | Crear |
| PATCH | `/api/prospects/{id}` | Editar |
| DELETE | `/api/prospects/{id}` | Eliminar |
| POST | `/api/prospects/{id}/convert` | Convertir a contact |
| POST | `/api/prospects/import` | Bulk import |
| POST | `/api/prospects/bulk-tag` | Agregar tags |
| GET | `/api/prospect-lists` | Lista de listas |
| POST | `/api/prospect-lists` | Crear lista |
| GET | `/api/prospect-lists/{id}/members` | Miembros |
| POST | `/api/prospect-lists/{id}/members` | Agregar miembros |
| DELETE | `/api/prospect-lists/{id}/members/{memberId}` | Remover miembro |
| POST | `/api/prospect-lists/from-selection` | Crear desde selección |

### Usuarios
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/users` | Lista |
| POST | `/api/users` | Crear |
| GET | `/api/users/{id}` | Detalle |
| PATCH | `/api/users/{id}` | Editar (incluye contraseña) |
| GET | `/api/users/{id}/visibility/available` | Contactos visibles para el usuario |

### Plantillas
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/templates` | Lista |
| POST | `/api/templates` | Crear |
| PATCH | `/api/templates/{id}` | Editar |
| DELETE | `/api/templates/{id}` | Eliminar |
| POST | `/api/templates/{id}/submit` | Submit a Meta |
| POST | `/api/templates/{id}/sync` | Sync con Meta |

### Blacklist
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/blacklist` | Lista |
| POST | `/api/blacklist` | Agregar |
| DELETE | `/api/blacklist/{id}` | Remover |
| POST | `/api/blacklist/import` | Bulk import |
| GET | `/api/blacklist/export` | Exportar |

### Automatizaciones
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/automations` | Lista |
| POST | `/api/automations` | Crear |
| PATCH | `/api/automations/{id}` | Editar |
| DELETE | `/api/automations/{id}` | Eliminar |
| POST | `/api/automations/{id}/toggle` | Activar / desactivar |
| GET | `/api/automations/logs` | Auditoría de ejecuciones |

### Settings
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/settings/frequency-rules` | Reglas de frecuencia |
| POST | `/api/settings/frequency-rules` | Crear regla |
| PATCH | `/api/settings/frequency-rules/{id}` | Editar |
| DELETE | `/api/settings/frequency-rules/{id}` | Eliminar |
| GET | `/api/settings/segmentation` | Config de segmentación |
| POST | `/api/settings/segmentation` | Actualizar |
| GET | `/api/settings/scoring` | Config de scoring |
| POST | `/api/settings/scoring` | Actualizar |
| GET | `/api/settings/audit-log` | Historial de cambios |

### Dashboard y estadísticas
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/dashboard` | Resumen general |
| GET | `/api/dashboard/casino` | Stats de casino |
| POST | `/api/dashboard/casino/sync` | Sincronizar casino |
| GET | `/api/dashboard/casino/risk` | Análisis de riesgo |
| GET | `/api/dashboard/crm` | Métricas CRM |
| GET | `/api/dashboard/caja` | Transacciones |
| GET | `/api/stats/overview` | KPIs principales |
| GET | `/api/stats/campaigns` | Stats por campaña |
| GET | `/api/stats/lines` | Stats por línea |
| GET | `/api/stats/templates` | Stats por template |
| GET | `/api/stats/export` | Export masivo |

### Notificaciones
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/notifications` | Lista |
| POST | `/api/notifications/mark-read` | Marcar leída |
| POST | `/api/notifications/mark-all-read` | Marcar todas leídas |
| GET | `/api/notifications/preferences` | Preferencias del usuario |
| PATCH | `/api/notifications/preferences` | Editar preferencias |

### Webhooks
| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/webhook/evolution` | Inbound de Evolution API (mensajes + status updates) |

### Misc y Admin
| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/send` | Envío manual de mensaje |
| GET | `/api/audit` | Audit logs globales |
| GET | `/api/proxies` | Lista de proxies |
| POST | `/api/proxies` | Agregar proxy |
| POST | `/api/admin/migrate` | Ejecutar migraciones |
| POST | `/api/admin/db-stats` | Estadísticas DB |
| POST | `/api/admin/debug-contact` | Debug info de contacto |
| POST | `/api/admin/sync-tags` | Resincronizar tags |
| POST | `/api/admin/resegment` | Resegmentar todos los contactos |
| POST | `/api/admin/test-casino-sync` | Test de sync casino |
| POST | `/api/upload` | Upload de archivo |

---

## 4. Base de datos — Entidades principales

### contacts
Jugadores / clientes registrados.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | UUID | PK |
| phone_number | TEXT UNIQUE | E.164 |
| first_name, last_name, email | TEXT | Datos personales |
| status | ENUM | active / inactive / blocked / opted_out |
| segment | ENUM | bajo / medio / vip / vip_medio / vip_alto / super_vip |
| gaming | ENUM | slots / deportivas / ambas |
| panel | TEXT | Betcoin / Zeus / Bigwin / etc |
| linea | INT | 1–100 |
| opt_in_marketing | BOOL | Consentimiento |
| platforms | JSONB | Plataformas detectadas |
| priority_score | NUMERIC | Score de prioridad |
| ltv_score | NUMERIC | Lifetime value |
| total_deposits, total_withdrawals | NUMERIC | Acumulados |
| last_deposit_at | TIMESTAMP | Última carga |

### campaigns
| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | UUID | PK |
| name, type | TEXT | |
| message | TEXT | Mensaje simple |
| messages | JSONB | Secuencia multi-mensaje |
| status | ENUM | draft / scheduled / running / paused / completed / cancelled |
| pause_reason | TEXT | Por qué se pausó |
| list_id | UUID | → contact_lists |
| prospect_list_id | UUID | → prospect_lists |
| antiblock_delay_min/max | INT | Delay en segundos |
| personalize_name | BOOL | Personalizar nombre |
| use_multi_line | BOOL | Rotación de líneas |
| anti_ban_profile_id | UUID | Perfil anti-ban |
| owned_by | UUID | → users |
| processor_locked_at | TIMESTAMP | Lock de procesamiento |

### whatsapp_lines
| Campo | Tipo | Descripción |
|-------|------|-------------|
| line_key | TEXT | Identificador único (line_01..line_30) |
| phone_number, evolution_instance | TEXT | |
| status, is_connected, sending_enabled | | Estado de la línea |
| msgs_sent_today, msgs_sent_hour | INT | Contadores |
| msg_per_day, msg_per_hour | INT | Límites configurables |
| allowed_types | JSONB | campaign / chatbot / sequence |
| line_type | ENUM | evolution / cloud |
| cloud_phone_number_id, cloud_waba_id | TEXT | Meta Cloud API |
| cloud_quality_rating | TEXT | Calidad (Meta) |
| owned_by | UUID | → users |

### warmup_numbers
| Campo | Tipo | Descripción |
|-------|------|-------------|
| phone_number, instance_name | TEXT | |
| warmup_status | ENUM | active / paused / completed / banned |
| current_day, target_days | INT | Progresión |
| messages_sent_today, total_messages_sent | INT | Contadores |
| daily_limit | INT | Límite del día |
| health_score | NUMERIC | 0–100 |
| delay_preset | ENUM | conservadora / normal / agresiva |
| anti_ban_enabled | BOOL | |

### campaigns_recipients
Tabla de estado por destinatario: pending / sent / failed / skipped.

### whatsapp_messages
Historial completo de mensajes con status tracking (sent / delivered / read / failed) y timestamps por estado.

### users
Usuarios del sistema con role, sectors (JSONB), y permisos adicionales (can_download_contacts, allowed_agents).

### blacklist
Números bloqueados con razón, fuente, auditoría de quién añadió/removió.

### automations
Flujos automáticos con trigger_config y action_config en JSONB.

### tasks
Tareas operacionales con tipos discriminados, prioridad, asignación y soft delete.

### casino_players / casino_transactions
Espejo de datos de casinos externos (Zeus, Bet30) para segmentación.

### anti_ban_profiles
Perfiles de configuración anti-ban con timing_mode, risk_tolerance, max_msgs_per_batch.

### app_settings / segmentation_tiers / scoring_config
Configuración global serializada en JSONB con audit trail.

### audit_logs
Logging completo de acciones (usuario, acción, recurso, metadata, timestamp). RLS habilitado.

---

## 5. Servicios y lógica de negocio

### Auth y RBAC (`lib/auth.ts`, `lib/permissions.ts`)
- HMAC-SHA256 para firma y verificación de tokens
- Timing-safe comparison para prevenir timing attacks
- `checkPermissionWithUser(req, resource, action)` — verifica role + sector
- `isOwnerOrAdmin(userId, ownedBy, isAdmin)` — verifica ownership

### Campaign Distributor (`lib/campaign-distributor.ts`)
- Procesa campañas en batches
- Selección de línea elegible: activa, conectada, con envío habilitado, dentro de rate limits
- Deduplicación con Redis
- Enforcement de frequency rules
- Delays anti-ban aleatorios

### Line Distributor (`lib/distributor.ts`)
- Filtros: status, is_connected, sending_enabled, msgs/hora, msgs/día, allowed_types
- Selección por prioridad + round-robin rotation

### Warmup Engine (`lib/warmup-engine.ts`, `lib/services/warming/`)
- Cálculo de progresión diaria (curva potencial)
- Ajuste por reputation_score
- Rotación de mensajes sin repetir < 48h
- **health-calculator.service.ts** — entrega, quejas, score
- **warming-orchestrator.service.ts** — plan de distribución diaria
- **warming-effectiveness.service.ts** — tracking de progreso
- **predictive-alert.service.ts** — alertas preventivas
- **warming-simulator.service.ts** — proyecciones

### Contact Frequency Engine (`lib/contact-frequency/ContactFrequencyEngine.ts`)
- Carga de reglas desde `app_settings`
- Enforcement en tiempo real durante dispatch
- Audit de remociones

### Scoring y Segmentación (`lib/user-prioritization/`, `lib/scoring/`)
- `UserPrioritizationService` — calcula priority_score compuesto
- `LtvService` — lifetime value calculation
- `ScoringConfigRepository` — carga de pesos desde DB
- `SegmentationConfigRepository` — definición de tiers

### Cloud API Client (`lib/cloud-api/`)
- Client HTTP para Meta Cloud API
- Queue de mensajes + rate limiter
- Verificación de webhooks (firma HMAC-SHA256)
- Token store cifrado
- Circuit breaker para resiliencia
- Coexistence sync handler (Evolution + Cloud simultáneamente)

### Casino Connectors (`src/casino-connectors/`)
- `BaseCasinoConnector` — interfaz base
- `ZeusConnector` — implementación Zeus API
- `Bet30Connector` — extiende Zeus (misma API, distinta URL)
- Factory pattern: `createConnector(platform)`
- Exponential backoff en reintentos
- Logging estructurado con pino

### Real-time (`lib/sse-events.ts`)
- SSE streams para conversaciones y warmup
- Reconnection automática en el cliente
- Desktop notifications (si el browser lo permite)

---

## 6. Integraciones externas

| Sistema | Propósito |
|---------|-----------|
| **Evolution API** | WhatsApp self-hosted: envío, recepción, QR, webhooks |
| **Meta Cloud API** | WhatsApp oficial: templates aprobados, Cloud API |
| **Chatwoot** | Inbox omnichannel para soporte humano |
| **Zeus Casino** | Datos de jugadores y transacciones vía API |
| **Bet30 Casino** | Igual que Zeus, distinta URL |
| **n8n** | Orquestación de workflows (warmup, sync, campañas) |
| **Redis** | Cache, deduplicación, rate limiting |
| **Playwright** | Scraping de datos de casino cuando no hay API |

### n8n Workflows activos
- `WF-010-Warmup-Orchestrator.json` — plan diario de warmup
- `WF-010a-Process-Single-Line.json` — procesa 1 línea (lógica compleja)
- `WF-010b-Daily-Reset.json` — reset límites a las 00:00 UTC
- `WF-ERR-Warmup-Error-Handler.json` — manejo de errores
- Pool de 200+ mensajes de warmup (`warmup-messages.json`)

### Scripts operacionales (21 scripts en `/scripts/`)
- `sync-casino-players-live.js` — fetch transacciones, upsert players
- `scrape-zeus-users.js` — scraping con Playwright
- `crear-listas-casino.js` — segmentos automáticos
- `segmentar-casino-players.js` — re-segmentación
- `importar-vcf.js` — VCF → contacts
- `run-migrations.mjs` — aplicar migraciones SQL
- `create-admin-user.mjs` — bootstrap admin
- `deploy-warmup-workflows.mjs` — deploy n8n
- (y más scripts de sync, análisis y reparación de datos)

---

## 7. Seguridad y acceso

### Autenticación
- HMAC-SHA256, sin JWT
- Sesiones de 7 días
- Timing-safe comparison en middleware
- Rate limiting en login: 5 intentos / 15 min

### RBAC
- 3 roles: admin | operator | viewer
- 14+ sectores granulares por usuario
- Ownership de recursos: campañas, líneas y listas tienen `owned_by`
- Permisos adicionales: `can_download_contacts`, `allowed_agents`

### Protección de datos
- No se loguean números de teléfono completos ni tokens en logs
- Tokens Cloud API cifrados en tránsito y en reposo
- Blacklist: opt-out y bloqueos manuales aplicados antes de todo envío

### Auditoría
- `audit_logs`: toda acción con user, recurso, metadata y timestamp
- `settings_audit_log`: cambios de configuración con valores anteriores/nuevos
- Logs de seguridad: validaciones fallidas
- Logs de automatizaciones: cada ejecución registrada

### Row-Level Security (RLS)
- Habilitado en Supabase
- Policies por tabla
- Funciones con `SECURITY DEFINER` para audit_logs

---

*Documento generado automáticamente a partir del análisis del codebase — 2026-06-18*
