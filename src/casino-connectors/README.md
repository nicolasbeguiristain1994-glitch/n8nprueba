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
├── index.js                     ← factory principal
└── README.md
src/config/
└── platforms.config.json        ← configuración centralizada de plataformas
```

## Plataformas registradas

| Plataforma | Tipo    | Clase                | Backend                           | Variables de entorno                     |
|------------|---------|----------------------|-----------------------------------|------------------------------------------|
| `zeus`     | `zeus`  | `ZeusConnector`      | `https://local-admin2.zeuscasino.fun` | `ZEUS_API_KEY`, `ZEUS_PLAYER_TOKEN`  |
| `bet30`    | `bet30` | `Bet30Connector`     | `https://local-admin2.bet30.world`    | `BET30_API_KEY`, `BET30_PLAYER_TOKEN`|

Variables opcionales de override de base URL: `ZEUS_API_BASE`, `BET30_API_BASE`.

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
| `username`      | `string`          | Username del jugador                               |
| `agente`        | `string`          | Username del agente responsable (del response API) |
| `tipo`          | `'carga'|'retiro'`| Tipo de transacción                                |
| `monto`         | `number`          | `Math.round(Math.abs(rawValue))`                   |
| `fecha`         | `string`          | `YYYY-MM-DD` en timezone local de la plataforma    |
| `fecha_hora_utc`| `string \| null`  | Timestamp ISO UTC completo si disponible           |
| `raw_detalles`  | `string`          | Descripción original de la transacción             |

---

## Lógica compartida (BaseCasinoConnector)

Los subclases heredan y no necesitan reimplementar:

| Método                                  | Descripción                                                             |
|-----------------------------------------|-------------------------------------------------------------------------|
| `aggregate(normalizedTxs)`              | Agrega por jugador → `PlayerSummary[]`                                  |
| `upsertPlayers(players)`                | Upsert en `casino_players`                                              |
| `insertTransactions(agente, txs)`       | Batch insert atómico en `casino_transactions` (BEGIN/COMMIT/ROLLBACK)   |
| `syncAgent(agente, desde, hasta)`       | Pipeline completo para un agente                                        |
| `_validateEnvVars(varNames)`            | Valida env vars en constructor — falla rápido antes de cualquier fetch  |
| `_fetchWithRetry(url, opts, context)`   | fetch con reintentos y backoff exponencial (ver política abajo)         |

### Atomicidad en insertTransactions

Todos los batches de `casino_transactions` para un agente se ejecutan dentro de una única transacción PostgreSQL. Si cualquier batch falla a mitad de camino, se hace `ROLLBACK` completo — nunca queda un estado parcialmente insertado.

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
npm test                  # suite completa (76 tests)
npm run test:coverage     # con reporte de cobertura
```

Archivos de tests en `tests/casino-connectors/`:

| Archivo                          | Tests | Cubre                                          |
|----------------------------------|-------|------------------------------------------------|
| `BaseCasinoConnector.test.js`    | 38    | atomicidad, reintentos, aggregate, upsert      |
| `ZeusConnector.test.js`          | 27    | fetch, normalización, fechas UTC→ART, healthCheck |
| `factory.test.js`                | 11    | resolución de clases, credenciales, plataforma desconocida |

Todas las llamadas HTTP y los timers de espera de reintentos están mockeados → la suite corre en < 1 segundo.
