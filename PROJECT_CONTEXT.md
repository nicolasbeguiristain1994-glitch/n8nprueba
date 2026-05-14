# WhatsApp Automation Platform — Contexto del Proyecto

> Archivo generado para asistencia de IA externa. Fecha: 2026-04-28.

---

## Propósito General

Plataforma de orquestación de comunicaciones vía WhatsApp para operaciones de **iGaming en LATAM**. Automatiza el ciclo completo del jugador: onboarding, retención, pagos, soporte y controles de riesgo.

**Objetivos clave:**
- Enviar 100% de eventos sin latencia manual (SLA < 2 min)
- Reducir fricción en onboarding (tasa completitud > 85%)
- Identificar riesgo antes de que afecte ingresos (detección < 24h)
- Automatizar 80% de interacciones de soporte
- Visibilidad operativa en tiempo real

---

## Stack Tecnológico

| Capa | Tecnología |
|------|-----------|
| Frontend + API | Next.js 16.2.3 + React 19.2.4 (TypeScript) |
| Base de datos | PostgreSQL (Supabase) — 33 migraciones |
| Cache / Queues | Redis |
| WhatsApp | Evolution API (wrapper oficial WA Business API) |
| Orquestación | n8n self-hosted (60+ workflows) |
| Scraping | Playwright |
| Estilos | Tailwind CSS 4 + ShadCN UI |
| Gráficos | Recharts |
| Testing | Vitest |
| Auth | HMAC-SHA256 custom (no JWT), sesiones 7 días |
| RBAC | admin / operator / viewer |

---

## Estructura de Carpetas

```
whatsapp-automation-platform/
├── frontend/
│   ├── app/
│   │   ├── (protected)/        # Rutas autenticadas
│   │   │   ├── page.tsx        # Dashboard principal (casino + difusión + riesgo)
│   │   │   ├── campaigns/      # Gestión de campañas
│   │   │   ├── contacts/       # Gestión de contactos
│   │   │   ├── conversations/  # Historial de mensajes
│   │   │   ├── lines/          # Pool de líneas WhatsApp
│   │   │   ├── distributor/    # Asignación de líneas
│   │   │   ├── tickets/        # Sistema de soporte
│   │   │   ├── users/          # Gestión de usuarios (admin)
│   │   │   └── warmup/         # Calentamiento de líneas
│   │   ├── api/                # 45+ API routes (Next.js)
│   │   └── login/              # Página de autenticación
│   ├── lib/
│   │   ├── db.ts               # Pool PostgreSQL (raw pg, sin ORM)
│   │   ├── auth.ts             # Sesiones HMAC
│   │   ├── permissions.ts      # RBAC
│   │   ├── audit.ts            # Logging de auditoría
│   │   └── distributor.ts      # Lógica de distribución de mensajes
│   └── components/
│       ├── Sidebar.tsx
│       └── ui/                 # ShadCN components
├── db/
│   ├── schema/                 # Esquemas SQL base
│   └── migrations/             # 33 migraciones incrementales
├── n8n/
│   └── workflow-specs/         # Especificaciones de workflows
├── scripts/                    # 15+ scripts operacionales (Node.js)
└── docs/
    ├── architecture/
    ├── audits/
    ├── workflows/
    └── runbooks/
```

---

## Modelos de Base de Datos

### contacts
```sql
id, external_id, phone_number, first_name, last_name, email,
status (active|inactive|blocked|opted_out),
segment (casual|regular|vip|whale),
opt_in_marketing, total_messages_received, last_activity_at
```

### campaigns
```sql
id, name, type (onboarding|retention|payment|risk_alert|support|promotion|survey),
status (draft|scheduled|running|paused|completed|cancelled),
message TEXT, messages JSONB,              -- mensaje simple o secuencia
media_url, media_type,
list_id, scheduled_at, started_at, completed_at,
antiblock_delay_min, antiblock_delay_max,  -- anti-ban WhatsApp
personalize_name BOOLEAN,
owned_by (UUID → users)                    -- ownership para RBAC
```

### contact_lists
```sql
id, name, description, total_members, owned_by
```

### whatsapp_messages
```sql
id, contact_id, phone, message_type, template_name, message_body,
status (sent|delivered|read|failed),
evolution_message_id, workflow_name,
sent_at, error_detail
```

### whatsapp_lines
```sql
id, line_key (line_01..line_30), phone_number, evolution_instance,
status, is_connected, sending_enabled, priority,
msgs_sent_today, msgs_sent_hour, msg_per_day, msg_per_hour,
allowed_types (campaign|chatbot|sequence), assigned_region
```

### whatsapp_templates
```sql
id, name, domain (onboarding|retention|payments|etc),
body TEXT, variables JSONB, language, active
```

### risk_flags
```sql
id, player_id, flag_type (bonus_abuse|multi_account|high_withdrawal|etc),
severity (low|medium|high|critical), resolved BOOLEAN
```

### casino_players
```sql
id, username, user_id, agente, total_cargas, actividad, valor_riesgo
-- Caché/espejo de datos del casino externo (Zeus)
-- Usado para segmentación y etiquetado automático
```

### tickets
```sql
id, status, priority, contact_id, assigned_to, line_id
-- Historial vinculado vía contacts.phone_number → whatsapp_messages
```

### contact_tags
```sql
contact_id, tag
-- Formato: "casino:actividad:baja", "casino:valor_riesgo:alto"
-- Se reemplaza la familia de tags al re-importar (sin duplicados)
```

### users
```sql
id, email, password_hash, role (admin|operator|viewer), sectors JSONB
```

### audit_logs
```sql
id, user_id, action, resource, resource_id, metadata JSONB, timestamp
```

### workflow_executions
```sql
id, workflow_name, trigger_event, status (success|error|skipped|timeout),
input_data JSONB, output_data JSONB, error_message, duration_ms
```

---

## Endpoints de API

### Autenticación
| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | /api/auth/login | Login (devuelve token HMAC) |
| POST | /api/auth/logout | Logout |
| GET | /api/auth/me | Usuario actual |

### Contactos
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | /api/contacts | Listar (filtros: segment, gaming, panel, linea, búsqueda) |
| POST | /api/contacts | Crear |
| GET | /api/contacts/[id] | Detalle |
| PUT | /api/contacts/[id] | Actualizar |
| POST | /api/contacts/import | Importar masivo CSV/XLSX |

### Campañas
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | /api/campaigns | Listar con métricas en vivo |
| POST | /api/campaigns | Crear |
| GET/PUT/DELETE | /api/campaigns/[id] | Detalle / Actualizar / Cancelar |
| POST | /api/campaigns/[id]/send | Disparar envío |
| POST | /api/campaigns/[id]/dispatch/process | Procesador background (lock-based) |

### Líneas WhatsApp
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | /api/lines | Listar con elegibilidad y rate limits |
| PATCH | /api/lines | Toggle sending_enabled |
| GET | /api/lines/qr | QR de autenticación Evolution |
| GET | /api/lines/health | Health check |

### Tickets
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET/POST | /api/tickets | Listar / Crear |
| GET/PATCH | /api/tickets/[id] | Detalle / Actualizar status |
| POST | /api/tickets/[id]/assign | Asignar agente |
| POST | /api/tickets/[id]/transfer | Transferir |
| POST | /api/tickets/[id]/messages | Enviar mensaje en ticket |
| POST | /api/tickets/[id]/notes | Agregar nota interna |

### Dashboard
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | /api/dashboard | Métricas generales |
| GET | /api/dashboard/casino | Datos casino (jugadores, agentes, VIPs) |
| GET | /api/dashboard/casino/players | Detalle de jugadores |
| GET | /api/dashboard/casino/risk | Análisis de riesgo |

### Otros endpoints
- `POST /api/send` — Mensaje individual
- `GET/POST /api/lists` — Listas de contactos
- `POST /api/lists/casino/repopulate` — Sync casino_players
- `GET/POST /api/proxies` — Gestión de proxies
- `GET/POST /api/warmup` — Campañas de warmup
- `POST /api/distributor/assign` — Asignar línea a contacto
- `GET /api/distributor/stats` — Estadísticas de distribución
- `GET /api/users` / `POST /api/users` — Gestión de usuarios
- `GET /api/audit` — Logs de auditoría
- `POST /api/webhook/evolution` — Webhooks inbound de Evolution API

---

## Sistema de Autenticación y RBAC

### Autenticación
- Token **HMAC-SHA256** custom (no JWT)
- Formato: `base64url(payloadJson).base64url(hmacSha256Bytes)`
- Duración: 7 días
- Verificación timing-safe

### Roles
| Rol | Permisos |
|-----|----------|
| admin | Acceso total a todos los recursos |
| operator | read, create, update, send en sectores asignados |
| viewer | Solo lectura en sectores asignados |

### Recursos protegidos
`dashboard, contacts, campaigns, conversations, lines, warmup, users, lists, send, audit, settings, tickets`

### Ownership
Campañas y listas tienen `owned_by` → solo el dueño o admins pueden modificarlas.

---

## Lógica de Envío de Campañas

1. Operador crea campaña con lista de contactos + mensaje (simple o secuencia JSONB)
2. Al disparar (`/send`), el dispatcher procesa contactos en batches
3. Para cada contacto: selecciona línea disponible vía `distributor` (respeta rate limits, tipo, región)
4. Envía a Evolution API con delay antiblock aleatorio (`antiblock_delay_min..max` ms)
5. Evolution API entrega el mensaje vía WhatsApp Business API
6. Webhook `/api/webhook/evolution` recibe status updates (delivered, read, failed)
7. Métricas actualizadas en tiempo real en `/api/campaigns/[id]`

**Deduplicación:** Redis hash `(phone, message_type, workflow_id, timestamp)` previene duplicados.

**Lock-based dispatcher:** Previene procesamiento concurrente de la misma campaña.

---

## Integración Casino (Zeus)

- `casino_players` — Espejo de jugadores del casino externo (Zeus)
- `scripts/sync-casino-players-live.js` — Sincronización periódica con Zeus API
- Tags automáticos en `contact_tags`:
  - `casino:actividad:baja/media/alta`
  - `casino:valor_riesgo:bajo/medio/alto`
  - `casino:antiguedad:nuevo/establecido/veterano`
- Al re-importar: se reemplaza la familia completa de tags (no acumula duplicados)
- Dashboard casino: métricas por agente, VIPs, jugadores en déficit, recuperables

---

## Scripts Operacionales

| Script | Descripción |
|--------|-------------|
| `sync-casino-players-live.js` | Sync en vivo con Zeus Casino API |
| `scrape-zeus-users.js` | Scraping de usuarios desde Zeus |
| `scrape-caja.js` | Scraping de transacciones de caja |
| `procesar-caja.js` | Procesamiento de transacciones |
| `crear-listas-casino.js` | Crear listas de contactos por segmento |
| `cargar-casino-players.js` | Cargar segmentación desde JSON a DB |
| `procesar-jerarquia.js` | Procesar jerarquía de agentes |
| `importar-vcf.js` | Importar contactos desde VCF |
| `analizar-historial.js` | Análisis de historial de mensajes |
| `obtener-jugadores-peaky.js` | Extracción desde sistema Peaky Blinders |

---

## Notas Técnicas Importantes

1. **Sin ORM** — Toda la DB se maneja con `raw pg` (no Prisma, no Sequelize, no Supabase client)
2. **`@supabase/supabase-js` instalado pero no usado** — Todo es conexión directa PostgreSQL
3. **Multi-line campaigns** — Soporte para enviar desde múltiples números simultáneamente
4. **Antiblock delay** — Delay aleatorio entre mensajes para evitar ban de WhatsApp
5. **Pool de 30 líneas** (`line_01..line_30`) con rate limits individuales por línea
6. **Deduplicación en Redis** — Previene reenvíos accidentales
7. **n8n workflows** — 60+ flujos de orquestación para eventos del jugador
8. **RBAC ownership** — Recursos tienen `owned_by` para multi-tenancy entre operadores

---

## Estado Actual del Proyecto (2026-04-28)

- Rama activa: `main`
- 33 migraciones aplicadas (última: casino actividad/perdido)
- Dashboard casino funcional con métricas de agentes, VIPs y riesgo
- Sistema de tags automáticos operativo
- Pendiente: optimizaciones en dashboard, nuevas segmentaciones

---

*Generado automáticamente desde el codebase. Para dudas de implementación, revisar `/docs/architecture/`.*
