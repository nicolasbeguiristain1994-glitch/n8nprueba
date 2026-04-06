# Workflow Spec: [NOMBRE DEL WORKFLOW]

> **Archivo:** `n8n/workflow-specs/DOMINIO_accion-trigger_v1.json`
> **Estado:** Draft / En desarrollo / Activo / Deprecado
> **Versión:** 1.0
> **Última actualización:** YYYY-MM-DD

---

## Objetivo

*Una oración describiendo qué hace este workflow y por qué existe.*

---

## Trigger

| Campo | Valor |
|-------|-------|
| Tipo | Webhook / Schedule / Manual / Event |
| Detalle | ej. POST /webhook/deposito-confirmado |
| Frecuencia | ej. Diario 08:00 ART (si es schedule) |

---

## Input esperado

```json
{
  "player_id": "uuid",
  "event": "string",
  "data": {}
}
```

---

## Flujo paso a paso

1. **Trigger recibe evento** → valida estructura del payload
2. **Consulta player** → obtiene datos del jugador desde Supabase
3. **Evalúa condición** → ej. si jugador está activo y tiene teléfono verificado
4. **Construye mensaje** → aplica plantilla con variables del jugador
5. **Envía por WhatsApp** → Evolution API
6. **Registra en DB** → tabla `whatsapp_messages`
7. **Manejo de error** → notifica a canal de alertas si falla

---

## Nodos n8n involucrados

| # | Tipo de nodo | Descripción |
|---|-------------|-------------|
| 1 | Webhook | Recibe el trigger |
| 2 | Supabase | SELECT player data |
| 3 | IF | Valida condiciones |
| 4 | Set | Construye payload del mensaje |
| 5 | HTTP Request | POST a Evolution API |
| 6 | Supabase | INSERT en whatsapp_messages |
| 7 | Slack/WA | Alerta de error |

---

## Plantilla de mensaje utilizada

Ver: `/src/templating/dominio-evento-default.txt`

---

## Condiciones de negocio

- Solo ejecutar si `player.status = 'active'`
- Solo si `player.phone_verified = true`
- No enviar entre 23:00 y 08:00 ART

---

## Tablas DB afectadas

| Tabla | Operación |
|-------|-----------|
| `players` | SELECT |
| `whatsapp_messages` | INSERT |

---

## KPIs a monitorear

- Tasa de entrega
- Tasa de error del workflow
- Tiempo de ejecución promedio

---

## Historial de cambios

| Versión | Fecha | Cambio |
|---------|-------|--------|
| 1.0 | YYYY-MM-DD | Creación inicial |
