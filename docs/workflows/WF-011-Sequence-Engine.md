# Workflow Spec: WF-011 — Sequence Engine

> **Archivo n8n:** `exports/WF-011-Sequence-Engine.json`
> **Estado:** Ready
> **Versión:** 1.0
> **Última actualización:** 2026-04-13

---

## Descripción

Motor de ejecución de secuencias automáticas (drip campaigns). Se dispara por cron cada 60 segundos, consulta los pasos vencidos en `sequence_executions`, resuelve la plantilla para cada contacto, envía el mensaje vía WF-007 y avanza (o cierra) la ejecución en DB.

Es el corazón de toda la automatización de marketing: onboarding, reactivación, cumpleaños, recordatorios.

---

## Trigger

| Campo | Valor |
|-------|-------|
| Tipo | Schedule (Cron) |
| Expresión | `* * * * *` (cada 1 minuto) |

---

## Flujo paso a paso

```
[Cron: cada 60s]
        │
        ▼
[Postgres: get_due_sequence_steps(100)]
   Retorna pasos vencidos con datos del contacto y config del paso
        │
        ├── 0 filas → [Termina silenciosamente]
        │
        └── N filas →
                │
                ▼
        [Split In Batches: 20]
                │
                ▼
        [Code: Resolve Template]
           1. Busca template_name en whatsapp_templates
           2. Interpolación: {{nombre}}, {{oferta}}, {{fecha}}, etc.
           3. Construye payload para WF-007
                │
                ▼
        [IF: dry_run?]
                ├── SI  → [Log: DRY_RUN_STEP] → [advance_sequence_step(id, true)]
                │
                └── NO  →
                        │
                        ▼
                [HTTP: WF-007 /webhook/send-whatsapp]
                { phone, message, contact_id, message_type: 'sequence' }
                        │
                        ├── 200/202 sent →
                        │       [Postgres: advance_sequence_step(id, true)]
                        │
                        └── 503 / error →
                                [Postgres: advance_sequence_step(id, false, error)]
                                -- Si falla 3 veces → status = 'abandoned'
```

---

## Nodos n8n

| # | Nombre | Tipo | Descripción |
|---|--------|------|-------------|
| 1 | Cron | `scheduleTrigger` | Cada 60 segundos |
| 2 | Postgres – Get Due Steps | `postgres` | `SELECT * FROM get_due_sequence_steps(100)` |
| 3 | IF – Has Steps | `if` | Termina si no hay pasos vencidos |
| 4 | Split In Batches | `splitInBatches` | Procesa de a 20 por iteración |
| 5 | Postgres – Get Template | `postgres` | `SELECT` la plantilla por `template_name` |
| 6 | Code – Render Message | `code` | Interpola variables del contacto en el body |
| 7 | IF – Dry Run | `if` | Bifurca ejecución real vs simulada |
| 8 | HTTP – WF-007 Send | `httpRequest` | POST a `/webhook/send-whatsapp` |
| 9 | IF – Send Result | `if` | Evalúa si el envío fue exitoso |
| 10 | Postgres – Advance Step (OK) | `postgres` | `advance_sequence_step(id, true)` |
| 11 | Postgres – Advance Step (FAIL) | `postgres` | `advance_sequence_step(id, false, error)` |
| 12 | Postgres – Log Dry Run | `postgres` | `advance_sequence_step(id, true)` sin envío real |

---

## Template Resolution (Nodo 6 — Code)

```javascript
const step      = $input.first().json;
const template  = $('Postgres – Get Template').first().json;

if (!template || !template.body) {
  throw new Error(`TEMPLATE_NOT_FOUND: ${step.step_config.template_name}`);
}

// Variables disponibles para interpolación
const vars = {
  nombre:   step.first_name  || 'Cliente',
  telefono: step.phone_number,
  fecha:    new Date().toLocaleDateString('es-AR'),
  oferta:   step.step_config.offer  ?? '',
  // Variables adicionales del step_config
  ...Object.fromEntries(
    Object.entries(step.step_config)
      .filter(([k]) => !['delay_hours','template_name','description'].includes(k))
  )
};

const renderedBody = template.body.replace(
  /\{\{(\w+)\}\}/g,
  (_, key) => vars[key] ?? `{{${key}}}`
);

return [{
  json: {
    ...step,
    rendered_message: renderedBody,
    template_id:      template.id,
    has_media:        template.use_media,
    media_url:        template.media_url ?? null
  }
}];
```

---

## Input de WF-007 (Nodo 8)

```json
{
  "phone": "+5491112345678",
  "message": "Hola Juan, tu oferta del 20% de recarga te espera. ¡Volvé hoy!",
  "contact_id": "uuid",
  "campaign_id": null,
  "message_type": "sequence",
  "region": "AR"
}
```

---

## Tablas DB afectadas

| Tabla | Operación |
|-------|-----------|
| `sequence_executions` | SELECT (get_due_steps) + UPDATE (advance_step) |
| `sequences` | SELECT (join en función) |
| `contacts` | SELECT (join en función) |
| `whatsapp_templates` | SELECT (por template_name) |
| `whatsapp_messages` | INSERT (vía WF-007) |

---

## Estados de ejecución

| Estado | Descripción |
|--------|-------------|
| `running` | Ejecución activa, hay pasos pendientes |
| `completed` | Todos los pasos fueron ejecutados |
| `abandoned` | 3 fallos consecutivos en el mismo paso |
| `opted_out` | El contacto envió STOP o fue desuscripto |

---

## Errores posibles

| Error | Causa | Acción |
|-------|-------|--------|
| `TEMPLATE_NOT_FOUND` | `template_name` no existe en DB | Log + `advance_step(false)`. No reintenta |
| `WF007_UNAVAILABLE` | WF-007 devuelve 503 | `advance_step(false)`. Reintenta en 1h |
| `NO_LINE_AVAILABLE` | WF-012 sin líneas disponibles | Ídem — reintenta en 1h |
| `CONTACT_INACTIVE` | `c.status != 'active'` | La función SQL ya los filtra — no llega al engine |
| `OPT_OUT` | `opt_in_marketing = false` | La función SQL ya los filtra |

---

## Notas de implementación

- El cron de 1 minuto con límite de 100 pasos por ejecución soporta ~6.000 pasos/hora antes de necesitar paralelismo.
- Si el volumen crece, aumentar el batch o activar múltiples instancias de n8n con particionado por `sequence_id % N`.
- `advance_sequence_step` usa `FOR UPDATE` para evitar race conditions si dos ejecuciones del cron se solapan (no debería pasar con n8n single-instance pero es seguro igual).
- `dry_run = true` ejecuta toda la lógica excepto el POST a WF-007. Útil para testing de secuencias.

---

## Workflows relacionados

| Workflow | Relación |
|----------|----------|
| WF-007 Send WhatsApp Message | Recibe cada mensaje individual |
| WF-018 Inactivity Trigger | Crea ejecuciones en `sequence_executions` |
| WF-012 Line Selector | Llamado internamente por WF-007 |
