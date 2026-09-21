# Plan — Métricas unificadas de las 4 plataformas de casino

> **Estado:** propuesta para revisión. No implementado.
> **Autor:** redactado por Claude a partir de una auditoría del código existente (2026-09-08).
> **Para el revisor:** cada afirmación sobre el código actual va con referencia `archivo:línea`.
> Si algo no cierra, verificalo ahí antes de asumir que el plan está mal.

---

## 1. Objetivo

Un dashboard operativo que muestre, para las 4 plataformas de casino (**Zeus**, **Bet30**,
**Ganamos**, **Argenbet**), métricas de cargas/retiros/jugadores actualizadas de forma
continua, con vista por plataforma y vista consolidada por operador.

**Definición de "tiempo real" que se adopta:** latencia máxima de **5 minutos** entre que una
transacción ocurre en el panel del casino y que se ve en el dashboard. No es streaming — ninguna
de las 4 plataformas emite eventos (webhooks/websockets); todas son APIs REST de consulta. Se
consigue con sync incremental frecuente + refresco del front. Cualquier promesa de latencia
menor sería falsa dado el modelo de las APIs upstream.

**No-objetivos de este plan** (explícitos, para acotar el review):
- No se rediseña el dashboard de WhatsApp (`/estadisticas`), que es de campañas y líneas.
- No se implementa el análisis de bonos más allá de una fase de *descubrimiento* (§7, Fase 5).
- No se migra la app a Supabase Realtime como transporte principal (queda como opción §6.3).

---

## 2. Por qué acá y no en un proyecto nuevo

La arquitectura multi-plataforma ya existe y **ya contempla las 4 plataformas por nombre**. Lo
que falta son dos archivos de conector y la corrección de varios huecos. Evidencia:

| Qué | Dónde | Estado |
|---|---|---|
| Config de las 4 plataformas | `src/config/platforms.config.json` | ✅ zeus, bet30, ganamos, argenbet declaradas con baseUrl, endpoint, timezone y `responseMapping` |
| Factory con lazy-require | `src/casino-connectors/index.js:13-17` | ✅ registra `ganamos` y `argenbet`; el require es perezoso *a propósito* porque los archivos no existen |
| Clase base (upsert, batching, retries, agregación) | `src/casino-connectors/base/BaseCasinoConnector.js` | ✅ 273 líneas reutilizables |
| Molde de conector con auto-login | `src/casino-connectors/zeus/ZeusConnector.js` | ✅ OAuth password-grant + normalización + healthCheck |
| Orquestador con chunking y concurrencia | `scripts/sync-casino-players-live.js` | ✅ `--platform`, `--auto`, `--chunk-days`, `--concurrency`, `--agentes` |
| Tablas | `db/migrations/025`, `028`, `031`, `123` | ✅ `casino_players`, `casino_transactions` con `fecha_hora_utc` y `platform` |
| Selector de plataforma en el front | `frontend/lib/casino-agents.ts:16` | ✅ `PLATFORMS` ya incluye ganamos y argenbet |
| Dashboard con widgets, filtros y auto-refresh | `frontend/components/dashboard/` | ✅ 15 widgets, refresh cada 300 s (`useDashboard.ts:46`) |
| Cruce jugador ↔ contacto de WhatsApp | `contacts.casino_accounts` (`db/migrations/109`) | ✅ solo existe en este repo |

**Consecuencia:** hoy, si un usuario elige "Argenbet" en el selector del dashboard, la UI
funciona pero muestra ceros — no hay conector que llene los datos. El trabajo es cerrar ese
hueco, no construir un sistema.

Un proyecto nuevo obligaría a reconstruir conectores, esquema, auth/RBAC y dashboard para
terminar leyendo la misma base, y perdería el cruce con contactos, que es el mayor valor.

---

## 3. Insumo ya validado manualmente (Argenbet)

Extracción hecha a mano desde la consola del navegador, con resultados verificados contra el panel:

- **Panel:** `admin.argenbet.net`, sección `/transactions/player`.
- **Endpoint:** `GET /api/backoffice/v1/account-transfers/player`
  (⚠️ nótese el sufijo `/player`; `platforms.config.json` hoy tiene el endpoint **sin** ese sufijo).
- **Auth:** header `authorization: Bearer <token>`; el token vive en
  `localStorage.auth_token.accessToken` y es un JWT del cual se extrae `agentUserId`.
- **Query params:** `operations[]=INCOME`, `operations[]=OUTCOME`, `agentUserId`,
  `dateFrom`/`dateTo` (ISO con offset `-03:00`), `offset`, `limit`.
- **Límite duro:** `limit > 50` devuelve **HTTP 400**. No hay campo `total` en la respuesta;
  se pagina por `offset` hasta recibir un lote más chico que el `limit`.
- **Forma del item (campos planos):** `amount`, `createdAt`, `operation`
  (`INCOME` = carga, `OUTCOME` = retiro), `fromUserId`/`fromUsername`/`fromUserRole`,
  `toUserId`/`toUsername`/`toUserRole`, `creatorUsername`, `from/toAccountBalance(After)`.
- **Regla de identificación del jugador:** el jugador es el lado cuyo `*UserRole === 'player'`
  (la contraparte es el agente). En depósitos está en `to`; en retiros, en `from`.
  Esta regla es más robusta que el `responseMapping` actual del config, que asume
  `usernameField: "toUsername"` — correcto para INCOME, **incorrecto para OUTCOME**.
- **Jerarquía de agentes:** el árbol tiene 3 niveles (`Adminbet` → `peaky` → `adminroyal`) — ver H10.
- **Validación:** agosto 2026, agente `adminroyal` (id `637255`): 1.715 movimientos,
  184 jugadores, depósitos 22.898.554 y retiros 14.920.991,67 — **coincide exacto con el panel**.

Esto es la especificación funcional del `ArgenBetConnector`. El script en sí vive en el navegador,
no en el repo; se re-implementa desde esta spec.

---

## 4. Hallazgos que bloquean o condicionan el trabajo

Estos son problemas **preexistentes** encontrados en la auditoría. Varios son invisibles hoy
porque solo se manifiestan al agregar plataformas o al sincronizar seguido. Son la parte del plan
que más conviene que el revisor cuestione.

### H1 — `upsertPlayers` acumula: re-sincronizar el mismo rango infla los totales
`BaseCasinoConnector.js:82-90`:
```sql
total_cargas = casino_players.total_cargas + EXCLUDED.total_cargas
```
La operación **suma**, no reemplaza. Es correcta bajo el supuesto "cada rango se sincroniza una
sola vez", que es el modo diario actual (`--auto` arranca en `MAX(fecha) + 1 día`). Con sync cada
5–15 minutos ese supuesto se rompe: el mismo día se procesa muchas veces y los agregados se
multiplican. Nótese que `casino_transactions` **sí** es idempotente (dedup por `id_rec`), así que
la fuente de verdad queda sana mientras los agregados se corrompen.

**Impacto:** bloqueante para el objetivo de tiempo real.
**Decisión propuesta:** ver D1.

### H2 — Un jugador que existe en dos plataformas colapsa en una sola fila
`casino_players` tiene `UNIQUE (username_lower)` global (`db/migrations/025_casino_players.sql:24-25`),
y el upsert hace `ON CONFLICT (username_lower)`. No hay plataforma en la clave. Si el usuario
`juan22` existe en Zeus y en Argenbet, sus totales se **suman en una sola fila** y
`agente`/`platform` quedan con el valor del último sync que corrió
(`platform = COALESCE(EXCLUDED.platform, casino_players.platform)`, línea 86).

Esto no es hipotético: el informe de agosto ya analiza "jugadores duales" que operan en dos
plataformas, y `bigwin` aparece como agente tanto en Zeus como en Bet30
(`frontend/lib/casino-agents.ts:26-27`).

**Impacto:** con 4 plataformas las métricas por plataforma son incorrectas por construcción.
**Decisión propuesta:** ver D2.

### H3 — Las queries del dashboard no filtran por `platform`
`frontend/app/api/dashboard/casino/route.ts` selecciona con `WHERE agente = ANY(...)`
(por ejemplo, línea ~110), usando la lista de agentes de la plataforma como *proxy* de la
plataforma. Funciona mientras los nombres de agente no se repitan entre plataformas — y ya se
repiten (`bigwin` en zeus y bet30; `zeus` es nombre de agente en bet30).

**Impacto:** contaminación cruzada de métricas. Depende de H2 para poder arreglarse bien.

### H4 — `POST /api/dashboard/casino/sync` tira 500 con ganamos o argenbet
`frontend/app/api/dashboard/casino/sync/route.ts`: `isValidSyncPlatform()` acepta las 4
(`frontend/lib/casino-agents.ts:84-86`), pero `PLATFORM_ENV_VARS` solo define `zeus` y `bet30`.
Con `platform=argenbet`, `creds` queda `undefined` y `creds.keyVar` lanza `TypeError`.
El mensaje de error del 400 también miente: dice "Valores permitidos: zeus, bet30".

### H5 — `consolidado` está hardcodeado a 2 plataformas
`frontend/components/dashboard/Dashboard.tsx:43`: `platform === 'consolidado' ? ['zeus','bet30'] : [platform]`.
Y `getAgentsForPlatform('consolidado')` (`casino-agents.ts:100`) devuelve solo los 6 agentes de
Zeus, mientras que `PLATFORM_AGENTS.consolidado` (línea 30) sí lista los 15. Inconsistencia
interna entre dos funciones del mismo archivo.

### H6 — Los montos son enteros; Argenbet tiene centavos
`casino_transactions.monto BIGINT` (`028:13`), `casino_players.total_cargas BIGINT` (`025:10`),
y `ZeusConnector.normalizeTransactions` hace `Math.round(Math.abs(valor))` (línea ~168).
El total validado de Argenbet es `14.920.991,67`. Redondear pierde centavos y los totales
dejarían de cerrar contra el panel — que es justamente la prueba de que la extracción es completa.

### H7 — `--auto` tiene granularidad de día, no de minuto
`scripts/sync-casino-players-live.js:~95`: `MAX(fecha) + INTERVAL '1 day'`. Usa la columna `fecha DATE`
e **ignora `fecha_hora_utc`**, que existe desde la migración 031 exactamente para esto. En modo
auto, el día en curso nunca se re-sincroniza: si ya hay transacciones de hoy, `desde` = mañana y
el guard `if (AUTO && desde > hasta)` corta con "Already synced — nothing to do".

**Impacto:** bloqueante para tiempo real; hoy solo sirve para el cron diario de las 04:00 UTC
(`n8n/workflow-specs/WF-030-Casino-Daily-Sync.json`).

### H8 — Sin `id_rec`, la dedup pierde transacciones legítimas
Índice de fallback: `UNIQUE (fecha, username, tipo, monto, agente) WHERE id_rec IS NULL` (`028:32-34`).
Usa `fecha` (DATE). Dos cargas del mismo jugador, mismo monto, el mismo día — algo perfectamente
normal — colisionan y la segunda se descarta. **La spec de Argenbet capturada en §3 no menciona un
campo `id`**, así que este riesgo es real hasta verificarlo.

**RESUELTO (2026-09-08).** La exportación manual de marzo–junio 2026 sobre `adminroyal` confirmó
que **todas** las filas traen `id` (salida `id presente en todas` en 4 meses consecutivos, ~5.500
transacciones). El conector puede mapear ese campo a `id_rec` y usar la deduplicación real por
`idx_casino_transactions_id_rec`, sin tocar el índice de fallback. Esto habilita D4
(ventana solapada) tal como está diseñada y **cierra el riesgo R3**.

### H9 — Argenbet identifica agentes por ID numérico, no por username
Todo el pipeline usa `agente VARCHAR` como clave (`syncAgent(agente, ...)`, `casino_players.agente`,
`getAgentes()` leyendo `SELECT DISTINCT agente`). Argenbet requiere `agentUserId=637255`.
Hace falta un mapa `username → agentUserId` o descubrirlo vía API.

### H10 — La lista de agentes de Argenbet en el front está un nivel de jerarquía más arriba
**RESUELTO** (confirmado en el panel, `admin.argenbet.net/users/agent`, árbol de usuarios).

`frontend/lib/casino-agents.ts:29` declara `argenbet: ['Horus', 'Hades', 'generalfranqui', 'peaky']`.
Esos son correctos, pero son los agentes de **primer nivel** (hijos de la raíz `Adminbet`).
`adminroyal` — sobre el que se validó la extracción — es un **hijo de `peaky`**, un nivel más abajo.

Jerarquía real:

```
Adminbet                        (raíz)
├── peaky                       (nivel 1)
│   ├── adminbtc                (nivel 2 — los que operan jugadores)
│   ├── adminfara
│   ├── adminzeus
│   ├── adminroyal              ← el validado en §3
│   ├── adminbigwin
│   ├── adminolimpus
│   ├── Adminmegawin
│   ├── Royalautos
│   └── Imperio
├── generalfranqui              (nivel 1)
├── Hades                       (nivel 1)
└── Horus                       (nivel 1)
```

Dos consecuencias:

1. **El nivel operativo son los hijos de `peaky`**, no `peaky` mismo. La lista del front hay que
   revisarla contra la decisión D7.
2. **El mapeo al operador canónico es casi directo**: sacando el prefijo `admin`, los nombres
   coinciden con los operadores ya conocidos del repo — `adminbtc`→betcoin, `adminfara`→farabet,
   `adminzeus`→ofizeus, `adminroyal`→royal, `adminbigwin`→bigwin. Esto responde en gran parte la
   pregunta abierta sobre el consolidado (§8.2). Quedan tres sin equivalente conocido en Zeus/Bet30
   (`adminolimpus`, `Adminmegawin`, `Imperio`) y uno sospechoso: **`Royalautos` en Argenbet vs.
   `royalauto`, que es el único agente de Ganamos** (`casino-agents.ts:28`) — hay que confirmar si
   es el mismo operador en dos plataformas o una coincidencia de nombre.

**El universo de Argenbet son 3 agentes, no 9** (confirmado por el operador, 2026-09-08): de los
nueve hijos de `peaky`, solo tres operan jugadores en esta plataforma. Los IDs están todos
confirmados, así que **no queda nada pendiente de descubrimiento para Argenbet**:

| Agente Argenbet | `agentUserId` | Operador canónico |
|---|---|---|
| `adminbtc` | 637249 | betcoin |
| `adminzeus` | 637252 | ofizeus |
| `adminroyal` | 637255 | royal |

Los otros seis (`adminfara`, `adminbigwin`, `adminolimpus`, `Adminmegawin`, `Royalautos`,
`Imperio`) existen en el árbol pero no tienen operación en Argenbet, y **no deben sincronizarse**.
Esto también descarta la duda sobre `Royalautos` vs. `royalauto` de Ganamos: no hay cruce.

`frontend/lib/casino-agents.ts:29` hay que reemplazarlo — hoy dice
`['Horus','Hades','generalfranqui','peaky']`, que no es ninguno de estos tres.

### H11 — No hay refresh de token a mitad de un run
`authenticate()` se llama una sola vez, antes del loop (`sync-casino-players-live.js:~230`), y
`_fetchWithRetry` trata cualquier 4xx como no-retriable (`BaseCasinoConnector.js:225-230`). Un 401 por
token vencido durante una carga histórica larga aborta ese agente sin reintentar.

**Confirmado en la práctica (2026-09-08):** durante la exportación manual de 6 meses de Argenbet, el
JWT venció a mitad de la corrida (401 en `offset=350` del quinto mes) y abortó todo lo que faltaba.
El TTL del token de Argenbet es corto — **no alcanza para una carga histórica larga**.

**Consecuencia para el conector:** `ArgenBetConnector` necesita re-`authenticate()` ante 401 y
reintentar la request, no solo al arrancar. Esto exige un cambio en `BaseCasinoConnector`, porque hoy
`_fetchWithRetry` clasifica todo 4xx como no-retriable: hay que tratar 401/403 como *retriable con
re-auth* mientras el resto de los 4xx siguen abortando. Es un cambio que **también beneficia a
Zeus/Bet30**, cuyos tokens duran 24–48 h y hoy fallan igual cuando expiran a mitad de un run.

---

## 5. Decisiones de diseño

Cada decisión lista la alternativa descartada, para que el revisor pueda impugnar el criterio.

### D1 — Separar la ingesta (idempotente) del cálculo de agregados
`casino_transactions` pasa a ser la única fuente de verdad. `casino_players` se vuelve una
proyección **recalculada**, no acumulada.

- El sync incremental escribe **solo** `casino_transactions` (ya idempotente vía `ON CONFLICT`).
- `upsertPlayers` se reemplaza por un recompute `INSERT ... SELECT` agregando desde
  `casino_transactions`, con `ON CONFLICT DO UPDATE SET total_cargas = EXCLUDED.total_cargas` (asignación, no suma).
- Ya existe precedente en el repo: `scripts/rebuild-casino-players-from-db.js` y
  `db/migrations/110_resegment_from_transactions.sql`. **Revisar si se puede reutilizar en vez de escribir nuevo.**

*Alternativa descartada:* hacer el upsert "restar lo viejo y sumar lo nuevo". Requiere saber qué se
insertó realmente en cada corrida y es frágil ante fallos parciales.

### D2 — Clave de `casino_players` = `(platform, username_lower)`
Migración que reemplaza el índice único global por uno compuesto. Es la corrección de H2/H3.

**Es la decisión más invasiva del plan** y toca código fuera de los conectores: cualquier lugar que
haga lookup por username asumiendo unicidad global. Hay que auditar al menos
`frontend/app/api/contacts/[id]/casino-stats`, `frontend/app/api/lists/casino`,
`scripts/segmentar-casino-players.js` y `db/migrations/116_player_ltv.sql`.

Las filas históricas tienen `platform IS NULL` (la columna se agregó recién en la migración 123, y
es nullable a propósito — ver el comentario de esa migración). Un índice único compuesto trata
cada `NULL` como distinto en Postgres, así que **hay que decidir el backfill antes de crear el
índice**: probablemente inferir la plataforma desde `agente` para los casos no ambiguos, y dejar
`bigwin` (ambiguo entre zeus y bet30) para resolución manual.

*Alternativa descartada:* dejar `username_lower` único y agregar sufijo de plataforma al username.
Rompe el cruce con `contacts.casino_accounts`, que guarda `{panel, username}` con el username real.

### D3 — Montos a `NUMERIC(18,2)`
Migrar `casino_transactions.monto` y `casino_players.total_cargas`/`total_retiros` a `NUMERIC(18,2)`.

*Alternativa descartada:* guardar centavos en `BIGINT`. Es más rápido pero obliga a dividir por 100
en cada consumidor (dashboard, exportadores a Excel, `116_player_ltv.sql`), y cualquier lugar que se
olvide muestra montos ×100. `NUMERIC` mantiene el significado en la base.

⚠️ **`pg` devuelve `NUMERIC` como string en JavaScript**, no como number. Hay que revisar los
consumidores del front que hoy reciben números; varias queries ya castean con `::int`, y hará falta
`::float8` o parseo explícito en el cliente. Riesgo concreto de regresión silenciosa.

### D4 — Sync incremental por ventana solapada, no por "desde la última fecha"
Nuevo modo `--desde-ultimo-timestamp` (o cambiar `--auto`) que calcula:
```sql
SELECT MAX(fecha_hora_utc) - INTERVAL '30 minutes' FROM casino_transactions WHERE platform = $1
```
El solapamiento de 30 min cubre transacciones que la API expone con retraso; la dedup por `id_rec`
absorbe los duplicados. Este diseño dependía de que hubiera un ID único por transacción —
**confirmado** para Argenbet (H8).

### D5 — Cadencia y costo
Ventana incremental de ~30 min a `limit=50` ⇒ decenas de items ⇒ 1–2 requests por agente por
corrida. Con ~15 agentes y sync cada 5 min: ~4.300 requests/día, repartidos. Es un volumen
prudente para un backoffice, pero **conviene confirmarlo con el operador de cada plataforma antes
de activarlo** — ninguna de estas APIs es pública ni tiene rate limit documentado.

La carga histórica inicial es otra cosa: usar `--chunk-days=7 --concurrency=1` y correrla a mano
una vez, fuera de horario.

### D7 — Sincronizar Argenbet al nivel de los hijos de `peaky`
La extracción se hace por `agentUserId`, y el árbol tiene tres niveles (H10). Hay que elegir uno:

- **Nivel 2 (`adminbtc`, `adminzeus`, `adminroyal`) — decidido.** Es el nivel donde los agentes
  operan jugadores reales, coincide con la granularidad del resto del repo (un `agente` por
  operador) y es lo que se validó contra el panel. Son **solo esos tres** y sus IDs ya están
  confirmados (H10) — no hay descubrimiento pendiente.
- Nivel 1 (`peaky`, `Hades`, `Horus`, `generalfranqui`): menos requests, pero solo sirve si la API
  devuelve las transacciones de todos los descendientes, y perdería la atribución por operador —
  que es el eje del dashboard.

El panel tiene un filtro **"Buscar en: Solo Directos"**, lo que confirma que la API distingue entre
transacciones directas y de todo el subárbol. **Hay que identificar ese parámetro en Fase 0**: es el
que determina si sincronizar padre e hijos produce doble conteo (R8).

*Nota:* `peaky`, `Adminbet`, `Horus`, `Hades` y `generalfranqui` quedan fuera del sync — el mismo
criterio de exclusión de nodos de capital que ya se aplica a `adminbet` y `surmar` en Zeus
(`casino-agents.ts:1-5`).

### D6 — El front no cambia de arquitectura
El dashboard ya tiene selector de plataforma, filtro por agente, rango de fechas, auto-refresh y
botón de sync. Se corrigen H4/H5 y se baja `AUTO_REFRESH_INTERVAL` de 300 s a ~120 s para el
objetivo de 5 min. No se agrega Supabase Realtime en esta etapa (ver §6.3).

---

## 6. Alcance por fase

Cada fase es independientemente entregable y verificable. Sugerencia: un PR por fase.

### Fase 0 — Descubrimiento (sin código de producción)
Preguntas que hay que responder **antes** de escribir el conector, porque cambian el diseño:

1. ~~¿La respuesta incluye un ID único por transacción?~~ **RESUELTO: sí, campo `id` en todas las filas.**
2. ~~¿Cuáles son los `agentUserId`?~~ **RESUELTO: son 3 agentes, todos con ID confirmado** (H10).
3. ¿Qué parámetro implementa el filtro **"Solo Directos"** del panel? Determina si un sync a nivel
   `peaky` incluiría a sus hijos y por lo tanto si hay riesgo de doble conteo (R8).
   Ideal: que el mismo endpoint del árbol de agentes (`/users/agent`) permita descubrir los IDs por
   API en vez de hardcodearlos.
4. ¿Cómo se autentica Argenbet por HTTP (endpoint de login, forma del body, TTL del JWT)? → hoy el token se toma a mano de `localStorage`.
5. Ganamos: ¿el endpoint `/api/agent_admin/user` del config existe y con qué auth? Hoy los datos de
   Ganamos llegan por Excel manual, así que el config puede estar sin validar.
   **Parcialmente resuelto** (sondeo del 2026-09-08, `docs/ganamos-sniffer-consola.js`):
   - **Auth por cookie de sesión**, no por token: ninguna request lleva header `authorization`.
     Es una diferencia estructural con Zeus/Bet30/Argenbet — el `GanamosConnector` tendrá que
     hacer login y mantener el cookie jar, no un Bearer. `playerTokenEnvVar` no aplica.
   - Prefijo confirmado: `/api/agent_admin/…` (coincide con el config del repo).
   - `GET /api/agent_admin/user/search/?username=X&is_direct_structure=false`
     → `[{id, role, can_create_only_player, username}]` — resuelve username → id.
   - `GET /api/agent_admin/user/{id}/tree/?username=` → `[{id, username, child_count, level}]`.
   - IDs: `admganamos` 23845278, `adminzeus` 23851856.
   - **RESUELTO** — endpoint de movimientos, validado contra el panel (adminroyal, agosto 2026):
     ```
     GET /api/agent_admin/user/{agentId}/payment/history/
       date_from, date_to        ISO sin zona ("2026-08-01T00:00:00")
       page, count               count=500 probado OK (10× el límite de Argenbet)
       role=0, username=""
       is_direct_structure=false        is_higher_transaction_only=false
       is_deposit_transfers=true        is_withdrawal_transfers=true
       is_bonus_deposits=false          transfers_only=true
     → { status: 0, result: { transfers: [ {id, operation, amount, created_at,
          from_user, to_user, initiator_user, note} ] } }
     ```
     `operation === 0` = depósito. El jugador es el lado que no es el agente.
     `created_at` viene **sin zona y es UTC**. Hay `id` por transacción → dedup real (igual que Argenbet).
     `status !== 0` señala error de aplicación con `error_message`, aparte del código HTTP.
   - IDs: `adminroyal` 24044323, `adminzeus` 23851856, `admganamos` 23845278.

**Entregable:** un documento corto con las respuestas + un JSON de muestra de cada endpoint,
guardado en `docs/`. **Sin esto, las fases 2 y 3 son especulativas.**

### Fase 1 — Correcciones de base (independiente de Argenbet)
Se puede hacer en paralelo a la Fase 0 y tiene valor propio: arregla bugs que ya afectan a Zeus/Bet30.

- Migración `125_casino_metrics_base.sql`: montos a `NUMERIC(18,2)` (D3); backfill de `platform`;
  índice único `(platform, username_lower)` (D2).
- Refactor de `upsertPlayers` → recompute desde transacciones (D1) + tests.
- Fix H4 (`PLATFORM_ENV_VARS` para las 4) y H5 (`consolidado` derivado de una sola constante).
- Fix H3: filtrar por `platform` en las queries de `/api/dashboard/casino`.
- Extraer los helpers de fecha de `ZeusConnector` (`_utcToArgDate`, `_extractUtcTimestamp`) a un
  módulo compartido — Argenbet y Ganamos los necesitan igual.
- Fix H11: `_fetchWithRetry` debe tratar 401/403 como retriable con re-`authenticate()`, dejando el
  resto de los 4xx como no-retriables. Beneficia a las 4 plataformas.

**Criterio de aceptación:** correr el sync de Zeus dos veces sobre el mismo rango deja
`casino_players.total_cargas` **idéntico** (hoy se duplica). Test de regresión explícito para esto.

### Fase 2 — `ArgenBetConnector`
`src/casino-connectors/argenbet/ArgenBetConnector.js`, extendiendo `BaseCasinoConnector` (Caso B
del `README.md` de conectores):

- `authenticate()`: login HTTP → JWT; re-login ante 401 **a mitad de run** (H11) — requisito duro,
  no opcional: el TTL del token no cubre una carga histórica.
- `id` de la API → `id_rec` (H8), habilitando dedup real.
- `fetchTransactions()`: paginación por `offset` con `limit=50` fijo, corte cuando el lote
  `< limit`, guard de páginas máximas para no ciclar infinito.
- `normalizeTransactions()`: tipo desde `operation` (`INCOME`→carga, `OUTCOME`→retiro); jugador
  desde el lado con `role === 'player'` (**no** desde `toUsername` como dice el `responseMapping`
  actual); `monto` sin redondear; `fecha` = fecha local AR, `fecha_hora_utc` = UTC.
- `healthCheck()`.
- Corregir el endpoint en `platforms.config.json`: agregar el sufijo `/player`.
- Tests en `tests/casino-connectors/ArgenBetConnector.test.js`, siguiendo `ZeusConnector.test.js`.
  Incluir un fixture con una fila INCOME y una OUTCOME para fijar la regla del rol.
- Variables en `.env.example`: `ARGENBET_ADMIN_USER`, `ARGENBET_ADMIN_PASSWORD`, `ARGENBET_API_BASE`.

**Criterio de aceptación — el más importante del plan:** sincronizar agosto 2026 para `adminroyal`
y obtener **1.715 transacciones, 184 jugadores, depósitos 22.898.554,00 y retiros 14.920.991,67**.
Son los números ya verificados contra el panel; cualquier desvío es un bug del conector.

### Fase 3 — `GanamosConnector`

> ⚠️ **Bloqueante abierto (2026-09-08).** `payment/history` sobre un agente devuelve **solo sus
> transferencias propias**, no las de su estructura descendente: `adminzeus` y `adminroyal` dan 2–3
> movimientos en mayo 2026, mientras el panel muestra $67.217.847 en depósitos para ese mes.
> Ni `is_direct_structure`, ni `is_higher_transaction_only`, ni `transfers_only` cambian el
> resultado, y mes-entero coincide con día-por-día, así que no es truncado ni paginación.
> **Ventana de consulta: 24 h, siempre** (confirmado por el operador). El panel no acepta rangos
> mayores y los agentes tienen mucho movimiento, así que el conector debe pedir día por día.
> Impacto: la carga histórica son ~31 requests por agente y por mes (más paginación), y el sync
> incremental consulta el día en curso completo — no una ventana de minutos como en D4.
>
> **RESUELTO (2026-09-08): el endpoint responde según QUIÉN pregunta.** Desde la sesión del propio
> agente devuelve todos sus movimientos; desde la sesión del administrador (`admganamos`),
> consultando el id de un subordinado, devuelve solo un puñado. Medición: los 80 nodos del árbol
> sumados desde la sesión de admin daban $100.100 en mayo 2026 contra $67.217.847 del panel.
> No es la jerarquía ni los parámetros: es la sesión.
>
> **Qué hace `transfers_only` (probado, 2026-09-08):** `true` devuelve las filas en
> `result.transfers`; `false` devuelve los **totales** del período y `result.transfers` vacío.
> No es un interruptor de histórico: son dos respuestas distintas del mismo endpoint. La request
> que el panel dispara al "Aplicar Filtro" usa `false` y por eso muestra los totales de marzo
> ($19.089.503 / $6.854.240,27) aunque con `true` ese mes venga en cero.
>
> **CERRADO: el detalle histórico no existe, tampoco para el panel.** "Cargar Operaciones" sobre
> el 01/03/2026 devuelve `{transfers: [], details: {total_count: 0, last_calculate_time: ...}}` y
> la UI muestra "NO SE ENCONTRARON RESULTADOS · 0 Registros", mientras los totales de ese día
> marcan $265.000. Ganamos conserva el detalle solo ~60 días y mantiene los agregados aparte
> (precalculados — de ahí `last_calculate_time`).
>
> **Consecuencia para el conector:** dos niveles de dato por diseño, no por limitación nuestra:
> - **Detalle por transacción** (jugador, hora, monto) → solo últimos ~60 días. Alimenta
>   `casino_transactions` y el cruce jugador ↔ contacto. **Hay que sincronizar seguido: lo que se
>   cae de la ventana se pierde definitivamente.**
> - **Totales diarios por agente** (`transfers_only=false`) → todo el histórico. Alcanza para KPIs,
>   evolución y comparativas del dashboard, pero no para segmentación por jugador.
>   `docs/ganamos-totales-historicos.js` los extrae. Verificado con `adminfara` marzo–agosto 2026:
>   los 6 meses salen completos (marzo $19.089.503 / $6.854.240,27, coincide con el panel).
>
> **Sin explorar todavía:** las secciones "Informes de jugadores → Historial de jugadores" y
> "Reportes financieros → Informe General" del panel. Si alguna devuelve cargas/retiros **por
> jugador** con más historial que `payment/history`, recupera la segmentación para los meses viejos.
> Es lo único que queda por probar antes de dar el histórico por perdido.
>
> **Segundo hallazgo (2026-09-08): con `transfers_only=true` solo llegan ~60 días.**
> Con `adminfara` (sesión propia), el primer día con movimientos fue 2026-07-09 estando a
> 2026-09-08: 61 días. Agosto vino completo, julio truncado en ese día, marzo–junio en cero.
> **No es que el agente no operara**: el panel, filtrado por marzo, muestra $19.089.503 en
> depósitos y $6.854.240,27 en retiros para ese mismo agente.
>
> Validación del exportador, en cambio, **perfecta**: agosto dio $23.372.265 / $8.509.064,50 en el
> script y exactamente lo mismo en el panel. El endpoint, los parámetros, la clasificación por
> `operation` y la dedup por `id` están bien; el problema es solo el alcance histórico.
>
> **Pendiente:** el panel accede al histórico completo, así que usa otro endpoint para el
> "Balance actual" y para "Cargar Operaciones". Hay que capturarlo desde la pestaña Network
> (el sniffer que parchea `fetch` dispara el anti-debug del sitio y cuelga la página).
> Dato de contraste para cuando aparezca: marzo 2026 de `adminfara` = $19.089.503 dep /
> $6.854.240,27 ret.
>
> Nota: "Balance actual" **sí es el total del período filtrado**, no un acumulado (verificado
> comparando agosto contra el script).
>
> **Impacto fuerte en el conector:** `GanamosConnector` necesita **credenciales de cada uno de los
> 6 agentes**, no una sola cuenta de administrador, y mantener 6 cookie jars independientes
> (login por agente → sincronizar sus días → siguiente). Esto no tiene equivalente en Zeus, Bet30
> ni Argenbet, donde un solo token cubre todos los agentes. Habrá que revisar si
> `platforms.config.json` puede modelar credenciales por agente o si hace falta otra estructura.


**Universo de agentes (confirmado por el operador, 2026-09-08):** Ganamos tiene **6 agentes
operativos**, no uno. `frontend/lib/casino-agents.ts:28` dice `ganamos: ['royalauto']`, que es
incorrecto y hay que reemplazar:

| Agente Ganamos | `agentId` | Operador canónico |
|---|---|---|
| `adminbtc` | 23851783 | betcoin |
| `adminzeus` | 23851856 | ofizeus |
| `adminroyal` | 24044323 | royal |
| `admbigwin` | 24045611 | bigwin |
| `amdfarabet` | 24050612 | farabet |
| `adminimperio` | 34139043 | imperio |

Los tres primeros se llaman **igual que en Argenbet**, lo que refuerza D2: la clave de
`casino_players` tiene que incluir la plataforma, porque el mismo `agente` existe en las dos.
El árbol tiene más nodos (`adminfara`, `admstock`, `admolimpus`, `admmega`, `royalautos`,
`admolympus`, `generalfranqui`, `general24/7`, `royalgana`) que **no** son operativos.

Mismo patrón que Argenbet, condicionado al resultado de Fase 0 punto 5. Si el endpoint no es accesible por API,
**esta fase se reemplaza** por un importador de Excel (la vía que se usa hoy) que escriba en
`casino_transactions` con `platform='ganamos'`. Ese fallback ya está esbozado en el informe de
agosto ("Importador de Excel para Ganamos y Argenbet").

### Fase 4 — Sync continuo
- Modo incremental por timestamp con solapamiento (D4).
- Extender `scripts/pipeline-diario.js` a las 4 plataformas (hoy solo hace Zeus y Bet30, líneas 109-110).
- Programar la corrida frecuente. Hay dos mecanismos ya en uso: el workflow n8n
  `WF-030-Casino-Daily-Sync` y el endpoint `POST /api/dashboard/casino/sync`. **Elegir uno solo** —
  tener las dos vías disparando syncs concurrentes sobre la misma tabla es pedir problemas.
- Lock para evitar solapamiento de corridas (advisory lock de Postgres, por plataforma).
- Bajar `AUTO_REFRESH_INTERVAL` a 120 s (`useDashboard.ts:46`).

**Criterio de aceptación:** una transacción hecha en el panel aparece en el dashboard en ≤5 min,
y correr el sync 10 veces seguidas no altera ningún total.

### Fase 5 — Bonos
**CONFIRMADO (2026-09-08):** la API de Ganamos tiene el parámetro **`is_bonus_deposits`**, que el
script validado usaba en `false` — por eso los bonos nunca aparecieron. Medido sobre `adminzeus`,
mayo 2026: **3 filas con `false`, 5 con `true`**. El flag agrega los bonos a la misma lista, así que
hay que traerlos en una consulta aparte (o marcarlos) para no romper la comparación de
depósitos/retiros contra el panel.
Si Ganamos los expone así, vale revisar si Argenbet tiene un flag equivalente (su panel tiene
un checkbox "Bonos" junto a Depósitos/Retiros, así que casi seguro existe el parámetro).

La extracción actual cierra exacto con el panel **porque** `operations[]=INCOME|OUTCOME` excluye
los bonos. Trabajo: inspeccionar el tráfico de la sección de bonos del panel, identificar el valor
de `operation` (o el endpoint alternativo), y decidir si los bonos van como `tipo` nuevo en
`casino_transactions` — lo que requiere ampliar el `CHECK (tipo IN ('carga','retiro'))` de `028:14` —
o en una tabla aparte. **Recomendación: tabla o columna aparte**, para no romper la validación de
totales contra el panel, que es la única prueba de completitud que existe.

---

## 7. Riesgos

| # | Riesgo | Mitigación |
|---|---|---|
| R1 | D2 (clave compuesta) rompe consumidores no auditados de `casino_players` | Grep exhaustivo antes de migrar; la migración es reversible salvo el backfill de `platform` |
| R2 | `NUMERIC` llega como string a JS y rompe cálculos del front en silencio | Castear en SQL; revisar cada widget que consume montos |
| ~~R3~~ | ~~Argenbet no tiene ID de transacción~~ | **Cerrado**: la API sí devuelve `id` en todas las filas (H8) |
| R4 | El sync frecuente hace que el panel corte el acceso por volumen | Empezar en 15 min, bajar gradualmente; medir; confirmar con el operador |
| R5 | El JWT de Argenbet vence a mitad de la carga histórica | Re-auth ante 401 (H11) |
| R6 | Backfill de `platform` ambiguo para `bigwin` (existe en zeus y bet30) | Resolución manual documentada; no adivinar |
| R7 | El endpoint de Ganamos en el config nunca fue validado | Fase 0; fallback a importador de Excel |
| R8 | Doble conteo si la API devuelve transacciones de descendientes y se sincroniza padre e hijos | Resolver el filtro "Solo Directos" en Fase 0; sincronizar un solo nivel (D7) |

---

## 8. Preguntas abiertas para el dueño del producto

1. ~~Nivel de agente y lista de agentes de Argenbet~~ — **RESUELTO**: 3 agentes, IDs confirmados (H10).
2. ~~Nombres exactos de los agentes de Ganamos~~ — **RESUELTO**: valen los del panel,
   `amdfarabet` (con `amd`) y `adminimperio`. Copiarlos literal, no "corregirlos".
3. **Jugadores duales** — cuando `juan22` juega en Zeus y en Argenbet, ¿el dashboard debe mostrarlo
   como una persona con dos cuentas, o como dos jugadores? Cambia si D2 alcanza o si hace falta
   además una entidad "persona".
4. **Histórico** — ¿desde qué fecha hay que cargar Argenbet y Ganamos? Determina el costo de la
   carga inicial.
5. **Frecuencia real necesaria** — ¿5 minutos es un requerimiento operativo o alcanza con 15/30?
   Baja el riesgo R4 de forma significativa.

---

## 9. Resumen del orden recomendado

```
Fase 0 (descubrimiento)  ─┐
                          ├─→ Fase 2 (ArgenBet) ─→ Fase 4 (sync continuo) ─→ Fase 5 (bonos)
Fase 1 (base, en paralelo)┘         │
                                    └─→ Fase 3 (Ganamos, condicional)
```

La Fase 1 tiene valor aunque no se haga nada más: arregla bugs que hoy afectan a Zeus y Bet30 en
producción (agregados inflados al re-sincronizar, métricas cruzadas entre plataformas).
