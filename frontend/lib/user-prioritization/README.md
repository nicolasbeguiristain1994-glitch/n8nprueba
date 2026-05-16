# Módulo de Priorización de Contactos para Difusión

## Propósito

Identifica y ordena automáticamente los contactos que deben recibir campañas de reactivación, priorizando a los de mayor valor que llevan tiempo sin depositar.

---

## ¿Quién entra en la lista de difusión?

Un contacto entra en la lista si cumple **todas** las condiciones siguientes:

1. **Estado operativo**: `status IN ('active', 'inactive')` — no suspendido ni cerrado.
2. **No excluido**: `do_not_contact = false` y `opt_in_marketing = true`.
3. **Historial de depósitos**: `last_deposit_at IS NOT NULL`.
4. **Dentro de la ventana de inactividad de su tier**:

| Tier  | Días inactivo elegibles |
|-------|------------------------|
| VIP   | 7 – 180 días           |
| ALTO  | 7 – 150 días           |
| MEDIO | 14 – 60 días           |
| BAJO  | 30 – 45 días           |

5. **Sin contacto reciente**: no haber recibido un mensaje hace menos de N días (cooldown por tier).

> **Nota sobre urgencyScore = 0**: Un contacto al final de su ventana (ej. VIP en día 180) tiene `urgencyScore = 0` pero **sí aparece en la lista**. Su `priorityScore = valueScore + 0 = 60`, que sigue superando a un contacto BAJO en la mitad de su ventana (score ≈ 31). El `urgencyScore = 0` significa "última oportunidad", no exclusión.

---

## Segmentos de difusión

La lista se divide en segmentos para que el operador elija el template y el tono adecuados:

| Segmento | Tiers | Inactividad | Estrategia de mensaje |
|---|---|---|---|
| `REACTIVACION_URGENTE` | VIP, ALTO | 7–30 días | Directo: "Te extrañamos, volvé" |
| `REACTIVACION_PRIORITARIA` | VIP, ALTO, MEDIO | 14–90 días | Con incentivo: bono, free spins |
| `REACTIVACION_ESTANDAR` | VIP, ALTO, MEDIO | 31–120 días | Oferta especial, torneo, novedad |
| `REACTIVACION_FRIA_ALTO_VALOR` | VIP, ALTO | 121–180 días | Win-back agresivo: oferta máxima |
| `REACTIVACION_FRIA` | BAJO | 30–45 días | Bajo costo, sin incentivo grande |

Los rangos exactos están definidos en `REACTIVATION_SEGMENT_RULES` de `config.ts`.

---

## Cómo se calcula el score (0–100)

```
priority_score = valueScore(0–60) + urgencyScore(0–40)
```

### valueScore — quién es el contacto

Constante por tier. Refleja el LTV relativo del grupo:

| Tier  | valueScore |
|-------|-----------|
| VIP   | 60        |
| ALTO  | 45        |
| MEDIO | 25        |
| BAJO  | 10        |

Se usa `total_deposit_amount` si está disponible; si no, el `segment` declarado.

### urgencyScore — cuándo contactarlo

Decae **linealmente** desde 40 (inicio de ventana) hasta 0 (fin de ventana del tier):

```
position = (daysInactive - window.min) / (window.max - window.min)
urgencyScore = round((1 - position) × 40)
```

**Ejemplos con tier VIP (ventana 7–180 días)**:

| Días inactivo | urgencyScore | total |
|---|---|---|
| 7   | 40 | 100 |
| 30  | 36 | 96  |
| 90  | 24 | 84  |
| 120 | 16 | 76  |
| 150 | 8  | 68  |
| 180 | 0  | 60  |

### Propiedad clave: valueScore garantiza el orden entre tiers

Un VIP al final de su ventana (score=60) **siempre supera** a un BAJO al inicio de la suya (score=50). El módulo no puede reordenar un contacto de menor valor por encima de uno de mayor valor.

---

## Arquitectura

```
config.ts                  ← Todas las constantes de negocio (fuente de verdad)
scoring.ts                 ← Funciones puras: resolveValueTier, scoreValue, scoreUrgency
prioritization-rules.ts    ← Función pura: checkEligibility (ventanas por tier)
UserPrioritizationRepository.ts  ← Acceso a datos (SQL raw)
UserPrioritizationService.ts     ← Orquestación: batch, locking, recompute
```

---

## Recompute

El score se recalcula en batch nocturnamente via `POST /api/contacts/recompute-priorities`.

- **Idempotente**: UPSERT por `contact_id`. Seguro ejecutar múltiples veces.
- **Locking**: tabla `system_jobs` en PostgreSQL — UPDATE atómico con TTL de 30 min.
- **Batch**: procesa 500 contactos por iteración para controlar el uso de memoria.

---

## Operación y Troubleshooting

### Locking + Heartbeat

El recompute usa un lock distribuido en PostgreSQL (tabla `system_jobs`, fila `prioritization_recompute`).

**Flujo de adquisición:**
1. La instancia genera un UUID (`lock_token`) y hace un `UPDATE ... WHERE is_running = false OR expires_at < NOW()`.
2. Si el UPDATE afecta 0 filas, otra instancia tiene el lock → lanza `RecomputeAlreadyRunningError` (HTTP 409).
3. Si tiene éxito, el lock queda con `is_running = true`, `expires_at = NOW() + 30 min` y `lock_token = <uuid>`.

**Heartbeat:**
Cada 5 minutos dentro del loop de batch, el servicio renueva el `expires_at` ejecutando `renewRecomputeLock(lockToken)`.
Si el renewal retorna `false` (el token ya no coincide — alguien expiró y retomó el lock), la corrida se aborta con `LockRevokedError` y queda registrada como `status = 'revoked'` en `recompute_runs`.

**Liberación:**
El `releaseRecomputeLock` valida `AND lock_token = $1` antes de liberar. Esto previene que una instancia caída libere el lock de quien lo tomó después.

---

### Qué es `last_complete_run_id`

Campo en `system_jobs` que apunta al `run_id` (= `lock_token`) de la última corrida que **completó exitosamente**.

Se escribe solo cuando `releaseRecomputeLock(success=true)`. Si la corrida falla o es revocada, **no se actualiza**.

El endpoint `GET /api/contacts/prioritized` filtra por defecto:
```sql
WHERE cps.run_id = (SELECT last_complete_run_id FROM system_jobs WHERE job_name = 'prioritization_recompute')
```
Esto garantiza que el operador siempre ve un snapshot consistente de la última corrida buena.

Para ver todos los datos (incluyendo corridas fallidas parciales): `?includePreviousRuns=true`.

---

### Cómo interpretar una corrida fallida

**1. Consultar el historial:**
```sql
SELECT run_id, started_at, status, contacts_processed, contacts_updated, duration_ms, error_message
FROM recompute_runs
ORDER BY started_at DESC
LIMIT 10;
```

**2. Ver el estado actual del lock:**
```sql
SELECT is_running, started_at, started_by, expires_at, last_success_at, last_complete_run_id
FROM system_jobs
WHERE job_name = 'prioritization_recompute';
```

**3. Correlacionar scores con un run específico:**
```sql
SELECT COUNT(*), reactivation_segment
FROM contact_priority_scores
WHERE run_id = '<run_id_de_la_corrida>'
GROUP BY reactivation_segment;
```

**4. Logs estructurados (Railway / stdout):**
Filtrar por `prioritization_recompute_end` con `status != 'success'`:
```json
{ "event": "prioritization_recompute_end", "status": "failed", "run_id": "...", "error": "..." }
```

---

### Cómo forzar manualmente un recompute

**Opción A — Via API (recomendado):**
```bash
curl -X POST https://<host>/api/contacts/recompute-priorities \
  -H "Cookie: <session>"
```

**Opción B — Si el lock está trabado (lock zombie):**
El lock expira automáticamente a los 30 minutos (`expires_at`). Después de eso, el próximo POST lo adquiere normalmente.

Para forzar sin esperar:
```sql
UPDATE system_jobs
SET is_running = false, lock_token = NULL, expires_at = NULL, started_by = NULL
WHERE job_name = 'prioritization_recompute';
```
> Solo ejecutar si estás seguro de que no hay ninguna instancia corriendo el recompute.

---

### Recomendaciones de monitoreo

| Alerta | Condición | Acción |
|--------|-----------|--------|
| Recompute fallido | `status = 'failed'` en `recompute_runs` más reciente | Revisar `error_message` y logs |
| Recompute revocado | `status = 'revoked'` consecutivos | Verificar si hay múltiples instancias compitiendo |
| Recompute no corre | `last_success_at < NOW() - INTERVAL '26 hours'` | Verificar cron / scheduler |
| Lock zombie | `is_running = true AND expires_at < NOW()` | El siguiente run lo libera automáticamente |
| Corrida larga | `duration_ms > 1800000` (30 min) | Verificar el volumen de contactos y ajustar `BATCH_SIZE` |

**Log events a alertar:**
- `prioritization_recompute_error` en stderr → fallo crítico
- `prioritization_recompute_end` con `status = 'revoked'` → competencia entre instancias

---

### Comportamiento en el primer deploy

1. `system_jobs.last_complete_run_id` es `NULL`.
2. `contact_priority_scores` está vacía.
3. El endpoint `GET /api/contacts/prioritized` devuelve resultado vacío (el filtro por `run_id` no aplica cuando `last_complete_run_id IS NULL`, pero la tabla está vacía de todas formas).
4. Ejecutar `POST /api/contacts/recompute-priorities` manualmente para la primera carga.
5. Después del primer recompute exitoso, `last_complete_run_id` queda seteado y el endpoint devuelve datos.
6. El cron nocturno mantiene los datos frescos automáticamente.

---

## Ruta hacia RFM (v2)

El módulo está preparado para evolucionar:

1. **Monto real**: cuando `total_deposit_amount` esté poblado, `resolveValueTier` lo usa automáticamente sin cambios en la lógica de negocio.
2. **Configuración desde admin**: todos los valores con `[DB-READY]` en `config.ts` pueden moverse a una tabla `priority_score_configs`.
3. **Frecuencia (F)**: `contact_send_history` ya existe; agregar `frequencyScore` como tercer componente.
4. **Monetary (M)**: `total_deposit_amount` como `monetaryScore` en lugar de usar segment como proxy.
