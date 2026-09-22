# Casino Connectors

Arquitectura extensible para sincronizar datos de jugadores desde múltiples plataformas de casino hacia las tablas `casino_players` y `casino_transactions`.

> Referencia rápida: [`README.md` raíz](../../README.md#casino--sincronización-multi-plataforma) para variables de entorno, CLI y cómo agregar plataformas.

## Estructura

```
src/casino-connectors/
├── base/
│   └── BaseCasinoConnector.js   ← clase abstracta + lógica DB compartida
├── zeus/
│   └── ZeusConnector.js         ← implementación Zeus Casino (backend completo)
├── bet30/
│   └── Bet30Connector.js        ← Bet30 skin de Zeus (hereda ZeusConnector)
├── argenbet/
│   └── ArgenBetConnector.js     ← implementación ArgenBet (fase 2, ver sección propia abajo)
├── index.js                     ← factory principal
└── README.md
src/config/
└── platforms.config.json        ← configuración centralizada de plataformas
```

## Plataformas registradas

| Plataforma | Tipo       | Clase              | Backend                               | Variables de entorno                       |
|------------|------------|---------------------|----------------------------------------|---------------------------------------------|
| `zeus`     | `zeus`     | `ZeusConnector`      | `https://local-admin2.zeuscasino.fun` | `ZEUS_API_KEY`, `ZEUS_PLAYER_TOKEN`         |
| `bet30`    | `bet30`    | `Bet30Connector`     | `https://local-admin2.bet30.world`    | `BET30_API_KEY`, `BET30_PLAYER_TOKEN`       |
| `argenbet` | `argenbet` | `ArgenBetConnector`  | `https://admin.argenbet.net`          | `ARGENBET_PLAYER_TOKEN` (Bearer, sin API key) |
| `ganamos`  | `ganamos`  | `GanamosConnector`   | `https://agents.ganamosnet.org`       | `GANAMOS_<AGENTE>_SESSION_COOKIE` (dev) o `GANAMOS_<AGENTE>_USER`+`_PASSWORD` — una sesión por agente, sin token de plataforma |

Variables opcionales de override de base URL: `ZEUS_API_BASE`, `BET30_API_BASE`, `ARGENBET_API_BASE`.

## Cómo agregar una nueva plataforma

Hay dos casos según qué tan diferente es la API del nuevo backend.

---

### Caso A — Skin del mismo backend (igual que bet30)

Cuando la API es idéntica a Zeus (mismo endpoint, misma estructura de respuesta, mismos headers), el conector es una clase vacía:

```js
// src/casino-connectors/<nombre>/<Nombre>Connector.js
'use strict'
const { ZeusConnector } = require('../zeus/ZeusConnector')
class NuevaConnector extends ZeusConnector {}
module.exports = { NuevaConnector }
```

Registro en `index.js`:
```js
const { NuevaConnector } = require('./nueva/NuevaConnector')
const CONNECTOR_MAP = { zeus, bet30, nueva: NuevaConnector }
```

Config en `platforms.config.json`:
```json
{
  "name": "nueva", "type": "nueva",
  "baseUrl": "https://local-admin2.nueva.com",
  "baseUrlEnvVar": "NUEVA_API_BASE",
  "apiKeyEnvVar": "NUEVA_API_KEY",
  "playerTokenEnvVar": "NUEVA_PLAYER_TOKEN",
  "endpoint": "/api/records/movimiento-fichas",
  "timezone": "-03"
}
```

---

### Caso B — Backend diferente (API distinta)

Cuando la API tiene endpoint, headers o estructura de respuesta distintos, extender directamente `BaseCasinoConnector`:

```js
// src/casino-connectors/<nombre>/<Nombre>Connector.js
'use strict'
const { BaseCasinoConnector } = require('../base/BaseCasinoConnector')

class NuevaConnector extends BaseCasinoConnector {
  constructor(config, pool) {
    super(config, pool)
    this._validateEnvVars([config.apiKeyEnvVar])   // ← falla rápido si falta
    this.apiKey = process.env[config.apiKeyEnvVar].trim()
  }

  async fetchTransactions(agentUsername, startDate, endDate) {
    // Construir URL y llamar a this._fetchWithRetry(url, options, `agent "${agentUsername}"`)
    // Retornar array de objetos raw
  }

  async normalizeTransactions(rawData) {
    // Mapear cada item al NormalizedTransaction shape (ver tabla abajo)
    // Filtrar: tipo desconocido, username vacío, transferencias entre agentes
  }

  async healthCheck() {
    // Retornar true/false según si la API responde
  }
}

module.exports = { NuevaConnector }
```

### Variables de entorno y ejecución

```env
NUEVA_API_KEY=...
NUEVA_PLAYER_TOKEN=...
NUEVA_API_BASE=...   # opcional
```

```bash
node scripts/sync-casino-players-live.js --platform=nueva --desde=2024-01-01 --hasta=2024-12-31
node scripts/sync-casino-players-live.js --platform=nueva --auto
```

### 5. Agregar agentes al dashboard (opcional)

Si la plataforma tiene datos propios en `casino_players`, agregar los agentes en `frontend/lib/casino-agents.ts`:

```ts
// frontend/lib/casino-agents.ts
export const PLATFORMS = ['zeus', 'bet30', 'nueva'] as const  // extender el tipo
type Platform = typeof PLATFORMS[number]

const PLATFORM_AGENTS: Record<Platform, string[]> = {
  zeus:  ['bigwin', 'ofizeus', ...],
  bet30: [],
  nueva: ['agente1', 'agente2'],
}
```

El selector de plataforma del dashboard se actualiza automáticamente al agregar la entrada.

---

## NormalizedTransaction — formato estándar

Contrato que todo `normalizeTransactions()` debe cumplir:

| Campo           | Tipo              | Descripción                                        |
|-----------------|-------------------|----------------------------------------------------|
| `id_rec`        | `string \| null`  | ID único del registro en la plataforma (si existe) |
| `source_id`     | `string \| null`  | ID crudo tal cual lo devuelve la API (opcional — solo lo usan conectores construidos sobre la identidad del importador de Excel, ver Argenbet abajo). `null`/ausente para Zeus/Bet30, que no lo necesitan. |
| `username`      | `string`          | Username del jugador                               |
| `agente`        | `string`          | Username del agente responsable (del response API) |
| `tipo`          | `'carga'|'retiro'`| Tipo de transacción                                |
| `monto`         | `number \| string`| `Math.abs(rawValue)` — sin redondear (D3: cargar/persistir cargas y retiros preserva centavos). Zeus usa `number`; Argenbet usa un string de 2 decimales fijos (`toFixed(2)`), igual convención que `src/casino-import/excel.js`, para no introducir error de punto flotante antes de llegar a SQL. |
| `fecha`         | `string`          | `YYYY-MM-DD` en timezone local de la plataforma    |
| `fecha_hora_utc`| `string \| null`  | Timestamp ISO UTC completo si disponible           |
| `raw_detalles`  | `string`          | Descripción original de la transacción             |

---

## Lógica compartida (BaseCasinoConnector)

Los subclases heredan y no necesitan reimplementar:

| Método                                  | Descripción                                                             |
|-----------------------------------------|-------------------------------------------------------------------------|
| `recomputePlayers(normalizedTxs)`       | Recompute (no acumula) `casino_players` desde `casino_transactions`, para los usernames tocados en esta corrida — un solo `INSERT...SELECT` con `SUM`/`COUNT`/`MIN`/`MAX` en SQL |
| `insertTransactions(agente, txs)`       | Batch insert atómico en `casino_transactions` (BEGIN/COMMIT/ROLLBACK), estampa `platform` y, si el conector lo provee, `source_id` |
| `syncAgent(agente, desde, hasta)`       | Pipeline completo para un agente                                        |
| `_validateEnvVars(varNames)`            | Valida env vars en constructor — falla rápido antes de cualquier fetch  |
| `_fetchWithRetry(url, opts, context)`   | fetch con reintentos y backoff exponencial (ver política abajo)         |
| `_assertNoIdentityCollisions(platform, chunk, client)` | Fase 2: antes de insertar un batch con `id_rec`, busca filas existentes con el mismo `(platform, id_rec)` y compara `source_id`/`monto`/`username`/`tipo`/`fecha`/`agente`. Si hay discordancia, **lanza** (nunca pisa datos con `ON CONFLICT`) — ver detalle abajo. |

### Atomicidad en insertTransactions

Todos los batches de `casino_transactions` para un agente se ejecutan dentro de una única transacción PostgreSQL. Si cualquier batch falla a mitad de camino, se hace `ROLLBACK` completo — nunca queda un estado parcialmente insertado.

### Colisiones de identidad (fase 2)

`insertTransactions` acepta `tx.source_id` (columna agregada por la migración 126, opcional: Zeus/Bet30 nunca lo traen). Antes de cada `INSERT ... ON CONFLICT (platform, id_rec)`:

1. `_dedupeIntraBatch` colapsa filas idénticas que comparten `(platform, id_rec)` dentro del **mismo** batch (p.ej. dos páginas de fetch solapadas trajeron la misma transacción) — Postgres rechaza un `INSERT` que toque el mismo target de `ON CONFLICT` dos veces, incluso si las filas son iguales. Si dos filas del mismo batch comparten `id_rec` pero **discrepan**, también lanza (no solo contra lo que ya está en la base). Las filas sin `id_rec` (Zeus/Bet30) tienen su propio `_dedupeIntraBatchWithoutId`, con la misma lógica pero clave `(platform, fecha, lower(username), tipo, monto, agente)` — el target de `ON CONFLICT` que usan esas filas.
2. `_assertNoIdentityCollisions` consulta si ya existe una fila en la base con ese `(platform, id_rec)` y, si existe, exige que coincidan `source_id` (cuando ambos lo tienen), `monto`/`username`/`tipo` **y también `fecha`/`agente`** — dos registros pueden compartir `id_rec`/monto/usuario/tipo y aun así discrepar en la fecha o el agente (p.ej. una corrección de fecha vía Excel), y eso también es una colisión real, no un no-op de re-sync. El `SELECT` trae `fecha::text` explícitamente para comparar siempre strings `YYYY-MM-DD`, nunca el objeto `Date` que node-pg devuelve por defecto para columnas `DATE`; `agente` se compara con `trim().toLowerCase()`.
3. La comparación de `monto` (`_montoEquals`/`_canonicalMonto`) canoniza el string decimal exacto (signo, ceros de más recortados) **sin pasar nunca por `Number`/`toFixed`** — node-pg devuelve `NUMERIC` como string (`"100.00"`) mientras que un conector puede traer un `number` (Zeus, `100`) o un string ya formateado (Argenbet); comparar con `String(a) !== String(b)` a secas rompería **todo** re-sync de Zeus, y pasar por `Number` perdería precisión en montos por encima de `Number.MAX_SAFE_INTEGER` (p.ej. `9007199254740991.01` vs `.02` se verían "iguales"). Un monto `null`/inválido nunca es igual a nada, ni siquiera a otro inválido.

Si hay discordancia real, **lanza un error** y el `ROLLBACK` de `insertTransactions` deshace todo el batch — nunca se resuelve la colisión sobreescribiendo en silencio. Esto es lo que garantiza que la misma transacción ingresada por la API y por el importador de Excel (mismo `id_rec` derivado del mismo `source_id`) dedupliquen en una sola fila, mientras que dos transacciones con el mismo monto pero IDs distintos siguen siendo filas independientes.

El `ON CONFLICT DO UPDATE` solo hace backfill de `fecha_hora_utc`/`source_id` cuando la fila existente realmente carece de esos valores (`casino_transactions.X IS NULL AND EXCLUDED.X IS NOT NULL`). **`insertedTxCount` cuenta exclusivamente inserts reales**, nunca ese backfill: ambos `INSERT` usan `RETURNING (xmax = 0) AS inserted` — `xmax = 0` es la señal propia de Postgres de que la fila viene de un `INSERT` genuino, no de la rama `ON CONFLICT DO UPDATE` — y `insertTransactions` suma solo las filas donde `inserted` vino `true`. Antes se sumaba `result.rowCount`, que cuenta cualquier fila tocada por el `UPDATE` de backfill; como Zeus/Bet30 nunca traen `source_id`, cada replay de la misma ventana volvía a "insertar" el mismo dato una y otra vez. Correr el mismo sync 10 veces ahora deja `insertedTxCount = 0` a partir de la segunda corrida.

`insertTransactions` toma el mismo advisory lock nombrado que usa `scripts/import-casino-excel.js` (`pg_advisory_xact_lock(hashtext('casino-excel-import'))`) de forma **incondicional**, para todo batch — no solo cuando trae `source_id`. El importador acepta archivos Movimientos de cualquier plataforma, así que un sync de Zeus/Bet30 (sin `source_id`, camino `_batchInsertWithoutId`) puede competir igual contra una importación Excel concurrente de esa misma plataforma; acotar el lock a `hasSourceId` dejaba esa ruta sin protección contra el mismo TOCTOU (chequeo-de-colisión + insert intercalado con el `INSERT` del importador). El lock sigue acotado a la transacción de Postgres (`xact_lock`, se libera solo en `COMMIT`/`ROLLBACK`) y nunca se retiene durante una llamada HTTP.

### Política de reintentos (_fetchWithRetry)

- **4 intentos totales** (1 original + 3 reintentos)
- **Backoff exponencial:** 1 s → 2 s → 4 s entre intentos
- **Se reintenta en:** errores de red, timeouts, respuestas 5xx
- **No se reintenta en:** respuestas 4xx (error de autenticación, bad request, etc.)
- **Log por reintento:** `[plataforma] Retry N/3 for agent "X" — Error: ... Retrying in Ns...`

### Validación de env vars (_validateEnvVars)

Llamar en el constructor del conector concreto para que los errores de configuración aparezcan en el momento de instanciar, no durante el primer fetch:

```js
constructor(config, pool) {
  super(config, pool)
  this._validateEnvVars([config.apiKeyEnvVar, config.playerTokenEnvVar])
  this.apiKey = process.env[config.apiKeyEnvVar].trim()
  // ...
}
```

---

## Logging

Los conectores usan **pino** vía `src/lib/logger.js`. Cada instancia crea un child logger con el campo `platform` vinculado:

```js
this.log = createLogger({ platform: config.name })
// → { "level":30, "platform":"zeus", "agent":"bigwin", "msg":"Sync completed", ... }
```

| Nivel   | Cuándo se emite                                                   |
|---------|-------------------------------------------------------------------|
| `debug` | Inicio de fetch por agente, cantidad de transacciones recibidas   |
| `info`  | Inicio y fin de cada sync (con `durationMs`, `txInserted`)        |
| `warn`  | Reintentos de fetch con contexto del error                        |
| `error` | Fallos de agente individuales, rollback de transacción            |

Configurar con `LOG_LEVEL=debug|info|warn|error` en el entorno. En `NODE_ENV=test` los logs se silencian automáticamente para no interferir con los tests.

---

## Tests

```bash
# Desde la raíz del repo
npm test                  # suite completa
npm run test:coverage     # con reporte de cobertura
```

Archivos de tests en `tests/casino-connectors/`:

| Archivo                          | Tests | Cubre                                          |
|----------------------------------|-------|------------------------------------------------|
| `BaseCasinoConnector.test.js`    | 56    | atomicidad, reintentos + re-auth en 401/403, recomputePlayers (estructura SQL), colisiones de identidad `source_id`/`fecha`/`agente` (fase 2), canonicalización exacta de `monto` sin `Number`/`toFixed`, conteo de `insertedTxCount` vía `RETURNING xmax=0` (nunca cuenta backfills), advisory lock incondicional (con y sin `source_id`) |
| `ZeusConnector.test.js`          | 36    | fetch, normalización, fechas UTC→ART, healthCheck, auto-login + redacción de secretos |
| `ArgenBetConnector.test.js`      | 46    | paginación, rol INCOME/OUTCOME (H10), timezone AR, precisión decimal, re-auth en 401, identidad compatible con el importador de Excel, colisiones intra/entre-batch, advisory lock compartido |
| `GanamosConnector.test.js`       | 73    | login por agente (cookie estática/adaptador), cookie jar real (rotación vía `Set-Cookie`, merge/borrado por nombre), ventana de 24h, paginación y corte en 500, `status!==0`, lado jugador/`operation`, validación estricta de `id`/`from_user`/`to_user`/`amount`, `created_at` naive-UTC, identidad compatible con el importador de Excel, aislamiento de cookies entre agentes concurrentes, re-auth scoped en 401, agente sin credenciales no frena a otros, `checkStaleSync` |
| `factory.test.js`                | 11    | resolución de clases, credenciales, plataforma desconocida |
| `recompute.test.js`              | 6     | idempotencia end-to-end (D1/D2/D3) contra un fake Postgres in-memory |

Todas las llamadas HTTP y los timers de espera de reintentos están mockeados → la suite corre en < 1 segundo.

### Variables OAuth de Zeus y Bet30

Para auto-login configurar también `<PLATAFORMA>_LOGIN_CLIENT_ID` y
`<PLATAFORMA>_LOGIN_CLIENT_SECRET` (`ZEUS` o `BET30`), además de API key y
usuario/contraseña. La configuración contiene únicamente los nombres de
esas variables; no se guardan los valores de las credenciales en ella.
El modo de token estático sigue disponible si no se configura auto-login.
Ver la guía de instalación y los pendientes de login de Argenbet/Ganamos
en `docs/runbooks/casino-api-sync-handoff.md`.
