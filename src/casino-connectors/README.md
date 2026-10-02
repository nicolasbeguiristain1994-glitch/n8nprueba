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

## Bonos como depósitos (decisión del usuario: 2026-09-15)

El usuario aclaró: «solo en zeus deben poner los bonos como deposito. si ves algo similar en otra plataforma, primero consultame». Solo para la plataforma con `config.name === 'zeus'`, una descripción con la palabra completa `bono` o `bonos`, sin distinguir mayúsculas, se normaliza como `tipo: carga` cuando no tenía ya un tipo carga/retiro reconocido. Por lo tanto, los depósitos y sus totales de Zeus incluyen estos bonos. Se conservan ID, monto con su normalización habitual, fecha y descripción original; aplican las mismas validaciones y deduplicación.

Bet30 y cualquier otra plataforma conservan su clasificación anterior aunque compartan con Zeus el conector o el formato de API. Un bono sin carga/retiro reconocido sigue siendo inválido: bloquea el preview y limita la cobertura del sync normal; no se registra automáticamente como depósito. Antes de agregar una regla equivalente en otra plataforma hay que consultar al usuario.

Se mantiene la prioridad existente: `Retiro de bono` sigue siendo retiro, `Carga de bono` sigue siendo carga y los movimientos `indirecto` continúan excluidos. Un fragmento de otro término o identificador (`abono`, `Josébono`, `bono_player`) no alcanza para reconocer un bono. Otros tipos desconocidos siguen contando como inválidos.

Esta regla afecta la normalización de las consultas posteriores, incluido el preview. No es un backfill ni modifica por sí sola filas históricas, agregados o cursores. Una ingesta real sigue sujeta a los controles de pausa y a la aprobación correspondiente.

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
| `normalizeWithStats(raw)`               | `{rows, invalid, excluded}`. Default conservador: toda fila descartada cuenta como inválida (certeza limitada). Sobrescribir si hay exclusiones esperadas |
| `prepareTransactions(normalizedTxs)`    | Normaliza `id_rec` (0/negativo/no numérico = sin ID), dedup en el lote, contadores de cobertura |
| `writeTransactions(client, agente, p)`  | Inserta en `casino_transactions` con `platform = config.name` (dedup por plataforma + ID) |
| `recomputePlayers(client, usernames)`   | Recalcula `casino_players` desde `casino_transactions` y **asigna** (no suma) |
| `persistSync(agente, p, hooks)`         | Ingesta + recompute (+ hooks del runner) en UNA transacción             |
| `syncAgent(agente, desde, hasta, hooks)`| Pipeline completo para un agente y un rango                             |
| `_validateEnvVars(varNames)`            | Valida env vars en constructor — falla rápido antes de cualquier fetch  |
| `_fetchWithRetry(url, opts, context)`   | fetch con reintentos y backoff exponencial (ver política abajo)         |

### Atomicidad e idempotencia (persistSync)

Por cada agente y tramo de fechas, en una única transacción PostgreSQL:

1. `INSERT` de los movimientos con su plataforma (`ON CONFLICT (platform, id_rec)`; sin ID, clave por día).
2. `pg_advisory_xact_lock` por jugador (orden de clave, sin deadlocks).
3. Recompute de los jugadores tocados desde `casino_transactions`, asignando totales.
4. Hooks del runner: registro del rango y avance del cursor.

Si cualquier paso falla se hace `ROLLBACK` completo. Repetir el mismo rango N veces
deja los mismos totales. `casino_players` sigue siendo único por `LOWER(username)`
(D2 pendiente, ver `docs/PLAN-METRICAS-4-PLATAFORMAS.md`).

La orquestación (lock por plataforma, cursor por agente, registro de corridas) vive en
`src/casino-connectors/sync/` — ver `docs/runbooks/centro-monitoreo.md`.

### Reglas para conectores nuevos

- `fetchTransactions` debe **lanzar** ante un cuerpo con formato desconocido (usar
  `SyncError('INVALID_RESPONSE', …)`); devolver `[]` solo si la API dijo "cero movimientos".
  Un `[]` inventado avanza el cursor sobre datos que nunca se leyeron.
- Los mensajes de error no pueden incluir cuerpos de respuesta, URLs ni mensajes de
  errores de red: usar status HTTP (`httpStatus`) y códigos. El runner igual persiste solo
  mensajes genéricos para errores que no sean `SyncError`.

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

## Preview de una primera sincronización

```bash
node scripts/sync-casino-players-live.js --preview --platform=zeus --agentes=betcoin --desde=2026-09-12 --hasta=2026-09-12
```

Exige esas opciones explícitas: plataforma `zeus` o `bet30`, exactamente un agente y un único día ya cerrado en Argentina. Cualquier otra opción se rechaza antes de conectar. Utiliza las credenciales configuradas para autenticar y consultar movimientos al proveedor; esos accesos pueden quedar registrados en el proveedor. Antes de un uso real hay que verificar el destino efectivo de PostgreSQL y los endpoints configurados.

La conexión de preview solicita `default_transaction_read_only=on` y comprueba `transaction_read_only` e aislamiento en cada transacción `REPEATABLE READ READ ONLY`. Todas las consultas usan tablas `public.*` y parámetros. No invoca el runner, persistencia, locks de sincronización, secuencias ni segmentación. No crea corridas ni guarda cursores. Puede consultarse durante `CASINO_SYNC_PAUSED=1`; ese control sigue aplicándose a toda escritura normal.

El JSON muestra contadores, fechas y sumas como cadenas de enteros, sin movimientos individuales, identidades de jugadores ni mensajes externos. Para los jugadores que la corrida recalcularía:

- **A_current:** agregados guardados actualmente; cero para jugadores nuevos.
- **B_existing_source:** suma del historial existente de todas las plataformas, incluidas filas sin plataforma, siguiendo las reglas actuales del writer. Si no hay fuente previa, vale cero como referencia contable; ejecutar un recompute sin fuente por sí solo dejaría la fila actual intacta.
- **C_projected:** agregados después de aplicar conceptualmente el lote y recalcular.
- **historical_recompute = B−A**, **new_batch = C−B** y **effective = C−A** separan la diferencia histórica del efecto del lote. Solo `effective` expresa el cambio total previsto de la corrida.

También informa inserciones, timestamps completados, revisiones del proveedor que el writer conservaría sin aplicar, cambios de agente/plataforma/fechas y cursor proyectado. No clasifica histórico ni propone reparación global. Incluye huellas SHA-256 del lote y del snapshot para comparar observaciones.

Bloquea el cálculo exacto (`impact: null`) ante histórico sin plataforma del mismo agente/día, colisiones globales de ID con histórico sin plataforma, filas inválidas o sin ID, conflictos fuera de los jugadores consultados, diferencias de case mapping, desbordes o empates de metadatos que dependan de un ID aún no asignado. Los límites son 5.000 movimientos, 250 jugadores y 50.000 filas históricas; superar uno bloquea el resultado. Las consultas tienen timeout de 20 s y espera de locks de 1 s.

`status: complete` describe el snapshot y el lote observados, sin garantizar que el proveedor haya entregado todo ni que la base siga igual. Nunca autoriza una importación. Una futura ejecución de escritura necesita revisión del impacto y aprobación aplicable; si cambian lote o base, hay que volver a evaluarlo. Código de salida: `0` preview completo, `1` bloqueado/fallo, `2` argumentos inválidos.
