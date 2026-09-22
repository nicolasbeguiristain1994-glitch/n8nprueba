# Sincronización API de cuatro plataformas — estado de implementación

Actualizado: 2026-09-21, sesión Claude Max (retomada desde el checkpoint de la
sesión anterior, que había agotado su ventana de 5 horas).

## Estado: FASE 1 completa, pendiente de aplicar en una base real

Todos los bloqueantes documentados por el coordinador (mailbox, mensajes 1-7)
están resueltos en el árbol de trabajo. No se aplicó la migración 127 ni se
ejecutó ningún sync real — eso queda para el dueño de la base, deliberadamente
(restricción explícita de esta tarea).

## Cambios de fase 1

### Identidad de jugador (D1/D2/D3)

- `db/migrations/127_casino_players_platform_identity.sql` (nueva):
  - `casino_players.total_cargas/total_retiros` → `numeric(20,2)` (antes
    `bigint`, perdía centavos).
  - Índice único compuesto `(platform, username_lower)` reemplaza el único
    global de la migración 025. Índice parcial adicional
    `(username_lower) WHERE platform IS NULL` para que scripts legacy no
    reintroduzcan colisiones NULL.
  - Backfill conservador de `platform` en `casino_players` **y**
    `casino_transactions` para agentes no ambiguos (zeus, bet30, y los 3 de
    Ganamos ya inequívocos hoy: admbigwin/amdfarabet/adminimperio). 'bigwin'
    (zeus y bet30) queda `NULL` a propósito — nunca se adivina — y se reporta
    por `RAISE NOTICE`.
  - Guard de colisión antes del backfill de `casino_transactions`: verifica
    tanto filas con `id_rec` (contra el índice `(platform, id_rec)` de la 126)
    como filas sin `id_rec` (contra el índice de dedup legacy→platform de la
    126, que cambia de comparación case-sensitive a case-insensitive). Si hay
    choque real, la fila se excluye del backfill y queda reportada, en vez de
    abortar la migración completa con un error de constraint.
  - Recrea `casino_segmentation_players` y `casino_contact_account_links`
    (dependían de las columnas ampliadas) agregando **toda** transacción con
    `platform` no nulo (no solo las importadas por Excel — así no se pierde
    el historial sincronizado por API cuando conviven ambas fuentes).
  - `refresh_player_ltv()` (migración 116): `PARTITION BY` ahora incluye
    `platform`, no solo `agente` — antes mezclaba el percentil de LTV de
    'bigwin' en zeus con 'bigwin' en bet30.

- `src/casino-connectors/base/BaseCasinoConnector.js`: escribe `platform` en
  cada insert/recompute (antes nunca lo hacía, pese a que la columna existía
  desde la migración 123); `recomputePlayers()` usa `SUM(...)::numeric(20,2)`
  sin `ROUND()::bigint`.
- `src/casino-connectors/zeus/ZeusConnector.js`: ya no redondea centavos
  (`Math.round` eliminado), sanitiza errores de login para no filtrar
  credenciales en logs.

### Dashboard y API (H3, H4, H5)

- `frontend/lib/casino-agents.ts`: `SYNC_PLATFORMS` como única fuente de
  verdad de "las 4 plataformas" (antes dos listas hardcodeadas de 2
  elementos que podían desincronizarse). `getPlatformFilterSql()` filtra
  estrictamente por la columna `platform`, sin fallback a lista de agentes
  (ese fallback mezclaba 'bigwin' zeus/bet30 y 'adminbtc' ganamos/argenbet).
  Agentes de Ganamos/Argenbet corregidos (antes eran placeholders
  incorrectos).
- `frontend/app/api/dashboard/casino/{route,players/route,risk/route}.ts`:
  GROUP BY/JOIN incluyen `platform`, no solo `agente`/`username`.
- `frontend/app/api/dashboard/casino/sync/route.ts`: modelo de credenciales
  para las 4 plataformas (antes solo zeus/bet30 estaban modeladas).
- `frontend/lib/user-prioritization/UserPrioritizationRepository.ts`
  (`getLtvMapForContacts`, **corregido en esta sesión, mensaje 8 del
  coordinador**): unía `player_ltv.casino_player_id` directo contra
  `casino_contact_account_links.player_id`, asumiendo que ese id ya era el
  UUID real de `casino_players`. Es falso para cualquier jugador con
  transacciones — ese id sale de `casino_segmentation_players`, que genera un
  id SINTÉTICO `md5('excel:'||platform||':'||lower(username))::uuid`, nunca
  igual al UUID real que escribe `refresh_player_ltv()`. El LTV desaparecía
  para casi todos los contactos pese a que los tests (basados en fixtures
  con datos ya esperados, no en SQL real) daban verde. Fix: unir primero a
  `casino_players` por `(username_lower, platform)` y de ahí a `player_ltv`
  por `casino_players.id`. Tests reescritos con fixture de IDs sintético/real
  deliberadamente distintos y assertion negativa contra el JOIN roto.
- `frontend/app/api/dashboard/casino/players/[username]/route.ts` (PATCH,
  **cambio de esta sesión**): `platform` ahora es obligatorio (400 si falta),
  `consolidado` rechazado explícitamente como destino de mutación, un único
  UPDATE por `(platform, username_lower)` exacto — antes podía actualizar
  todas las filas que compartían username entre plataformas. Sin callers UI
  todavía (nadie lo invocaba). Tests nuevos:
  `frontend/lib/__tests__/casino-players-username-route.test.ts`.

### Auditoría de consumidores adicionales (esta sesión)

- `frontend/app/api/contacts/[id]/casino-stats/route.ts`: filtraba jugadores
  solo por `agente = ANY(lista)`, sin columna `platform` — con 'bigwin'
  compartido entre zeus/bet30 podía traer el jugador equivocado. Se agregó
  filtro estricto de `platform` (mismo `getPlatformFilterSql` que el resto
  del dashboard).
- `frontend/app/api/admin/sync-tags/route.ts` y
  `frontend/app/api/contacts/import/route.ts`: el JOIN por tokens de nombre
  contra `casino_players.username_lower` no distinguía plataforma — un
  username compartido entre dos plataformas producía fan-out (2 filas) y el
  `UPDATE ... FROM`/`INSERT` tomaba una fila arbitraria. Se restringió a
  matches inequívocos (`COUNT(*) OVER (PARTITION BY username_lower) = 1`) en
  ambos.
- `scripts/importar-vcf.js`: mismo fan-out, mismo fix.
- `scripts/cargar-casino-players.js`: usaba
  `ON CONFLICT (username_lower)`, índice que la 127 elimina; su fuente
  (`jugadores_metricas.json`) no tiene `platform` y no puede participar en la
  nueva identidad. Se bloqueó con un mensaje explícito (reemplazo:
  `scripts/rebuild-casino-players-from-db.js` o
  `scripts/segmentar-casino-players.js`) en vez de dejar que falle con un
  error críptico de Postgres.
- `frontend/app/api/admin/fix-platforms/route.ts` y
  `.../contacts/recompute-platforms/route.ts` (**corregido en esta sesión,
  mensaje 8**): usan `EXISTS` (booleano, sin fan-out), pero eso no bastaba —
  el `EXISTS` matcheaba por `agente = ANY(lista)` sin columna `platform`, y
  'bigwin' es agente de zeus Y bet30, así que un jugador bet30 podía
  etiquetarse como zeus (o viceversa). Se agregó `cp.platform = 'zeus'`/
  `'bet30'` explícito a cada `EXISTS`. Tests nuevos en
  `frontend/lib/__tests__/casino-platform-guards-admin.test.ts`.
- `frontend/app/api/admin/migrate/route.ts` (**corregido en esta sesión,
  mensaje 8**): replica pasos de migraciones históricas (110a-115a) que
  asumen identidad global por `username_lower` sin `platform` — si se
  re-ejecutan después de la 127 pueden mezclar plataformas. Se agregó un
  guard: si el índice compuesto de la 127 existe, esos 12 pasos se saltan
  con un mensaje explícito (reemplazo: `scripts/rebuild-casino-players-from-db.js`
  o `scripts/segmentar-casino-players.js`) en vez de correr con datos
  potencialmente mezclados. Los pasos puramente regex (114b/115b/115c, sin
  `casino_players`) no se tocaron. Mismo archivo de test que el punto anterior.
- `frontend/lib/casino-lists.ts` / `frontend/app/api/lists/casino/**`: no
  referencian `casino_players`/`casino_transactions` directamente —
  confirmado fuera de alcance.
- `scripts/segmentar-casino-players.js`: ya reescrito (sesión anterior) sobre
  las vistas platform-aware de la 126 — confirmado, sin cambios.

### `.env.example`

Se agregaron (comentadas, sin valores reales) las variables de las 4
plataformas: `ZEUS_ADMIN_USER/PASSWORD`, `BET30_ADMIN_USER/PASSWORD`,
`ARGENBET_PLAYER_TOKEN`/`ARGENBET_ADMIN_USER/PASSWORD`, y los 6 pares
`GANAMOS_<AGENTE>_USER/PASSWORD` (adminbtc, adminzeus, adminroyal,
admbigwin, amdfarabet, adminimperio).

## Verificación

Fase 1 (sesión anterior):
- Raíz: `npm test -- --runInBand` → 96 aprobados, 1 omitido (6/7 suites, 1 skip).
- Frontend: `npx vitest run` → 822 aprobados, 6 omitidos (43/44 archivos, 1 skip).
- Frontend: `npx tsc --noEmit --incremental false` → sin errores.

Fase 2 (esta sesión, ArgenBetConnector — frontend NO se tocó, no se volvió a
correr vitest/tsc por no haber cambios en ese árbol):
- Raíz: `npm test -- --runInBand` → 145 aprobados, 1 omitido (7/8 suites, 1
  skip) — incluye `tests/casino-connectors/ArgenBetConnector.test.js` (46
  tests) y las ampliaciones de `BaseCasinoConnector.test.js` (37→40).

Estos resultados verifican comportamiento contra mocks/fixtures, no contra
una base Postgres real — la migración 127 no fue aplicada ni validada contra
una base real en ninguna sesión. El dueño de la base debe correrla y revisar
los `RAISE NOTICE` (jugadores/transacciones ambiguos) antes de desplegar el
`BaseCasinoConnector` actualizado.

No se ejecutaron migraciones, sync reales, ni llamadas de red en ninguna
sesión. No se tocó el importador de Excel ni las migraciones existentes
(116/123/126). No se tocó `AGENTS.md`/`CLAUDE.md`.

## Fase 2 — `ArgenBetConnector` (completa, sesión siguiente)

**Implementado y en verde.** `src/casino-connectors/argenbet/ArgenBetConnector.js`
extiende `BaseCasinoConnector`. `npm test` (raíz) en verde con este trabajo
incluido — ver "Verificación" más abajo para el conteo exacto. Ganamos sigue
**sin conector** (fase 3, no tocada en esta sesión).

### Qué hace

- Endpoint `GET /api/backoffice/v1/account-transfers/player` (el `/player`
  que faltaba en `platforms.config.json` ya está agregado). Auth Bearer JWT
  únicamente — sin `X-Api-Key` (a diferencia de Zeus/Bet30); se quitó
  `apiKeyEnvVar` del config de argenbet porque nada lo lee.
- Paginación por `offset`, `limit` FIJO en 50 (constante, no configurable —
  la API devuelve HTTP 400 por encima de eso). Un batch más chico que 50
  termina la paginación; un batch **más grande** que 50 (la API ignorando el
  parámetro) hace throw en vez de asumir que todo sigue bien. Tope de
  páginas (`config.maxPages`, entero positivo validado en el constructor) —
  si se supera, throw, nunca un resultado parcial silencioso.
- 3 agentes EXACTOS hardcodeados en el conector (`adminbtc`→637249,
  `adminzeus`→637252, `adminroyal`→637255) — `config.agentIds`, si se
  provee, debe matchear esto exactamente o el constructor tira.
- Rol de jugador por `toUserRole`/`fromUserRole === 'player'` (nunca
  `toUsername` fijo — así es como el plan documenta que `OUTCOME` se
  identificaba mal). `agente` en la fila persistida es siempre el agente con
  el que se pidió esa página (no `creatorUsername` del payload).
- Identidad idéntica al importador de Excel: reutiliza literalmente
  `recordId()` y `amount()` de `src/casino-import/excel.js` (no las
  reimplementa) — mismo `id_rec`/`source_id` para el mismo dato por
  cualquiera de los dos caminos, sin duplicar.
- Fecha/hora: `fecha` en horario Argentina (UTC-3 fijo, sin DST) +
  `fecha_hora_utc` ISO completo, vía `shared/dateHelpers.js` (mismo módulo
  que ya usa Zeus). `dateFrom`/`dateTo` se arman con el mismo patrón que el
  script de referencia validado manualmente por el dueño
  (`docs/argenbet-export-consola.js`): `new Date(...).toISOString()`
  (sufijo `Z`, no `-03:00`) — se preservó así a propósito en vez de cambiar
  el formato, ver "Feedback de revisión aplicado" abajo.
- Montos: pesos con centavos, sin redondear — reutiliza el validador
  `amount()` del importador (rechaza más de 2 decimales en vez de
  redondearlos con `toFixed(2)` a ciegas) y nunca convierte `amount`
  `null`/`''` a `0`.
- Política de registros malformados (más estricta que el borrador inicial,
  ver feedback abajo): una operación que no es `INCOME`/`OUTCOME` (p.ej. un
  bono) se descarta con warning — está genuinamente fuera de alcance (igual
  que "indirecto" en Zeus). Cualquier otra cosa rara en un registro que SÍ es
  `INCOME`/`OUTCOME` (rol de jugador ambiguo, sin id, sin `createdAt`, sin
  username, monto inválido) hace **throw** — H8 confirmó que todas las filas
  reales traen id, así que faltarlo es un dato roto, no un caso fuera de
  alcance, y una fase 4 futura que avanza su checkpoint por
  `MAX(fecha_hora_utc)` no debe poder perder filas en silencio.
- `authenticate()`: sin adaptador de login inyectado es un **no-op seguro**
  (igual que `ZeusConnector` sin `ADMIN_USER`/`ADMIN_PASSWORD`) — necesario
  porque `scripts/sync-casino-players-live.js` llama
  `await connector.authenticate()` una sola vez, sin condicionar, ANTES del
  primer request, para las 4 plataformas por igual. Si tirara acá, el modo
  "solo `ARGENBET_PLAYER_TOKEN` estático" (el único que existe hoy) sería
  inutilizable. La falla visible ante un 401 persistente sigue ocurriendo,
  solo que la tira `_fetchWithRetry` (H11, ya existente) después de agotar
  el único reintento post-reauth — nunca queda en loop ni en éxito vacío
  falso. Con un `loginAdapter` inyectado (constructor, 3er argumento —
  interfaz `{ login(): Promise<{ token }> }`), si éste devuelve sin token,
  eso sí tira. El endpoint de login real sigue siendo un TODO explícito en
  el código (URL/método/body/TTL/refresh — no inventado).

### `BaseCasinoConnector` — soporte genérico para `source_id` (fase 1 no se tocó)

- `insertTransactions` ahora persiste `tx.source_id` (columna de la
  migración 126, sin usar hasta ahora desde ningún conector).
- `_assertNoIdentityCollisions` + `_dedupeIntraBatch`/`_dedupeIntraBatchWithoutId`:
  antes de insertar, compara cualquier fila ya existente (o cualquier otra
  fila del mismo batch) que comparta identidad — `(platform, id_rec)` para
  filas con `id_rec`, `(platform, fecha, lower(username), tipo, monto,
  agente)` para las que no lo tienen (Zeus/Bet30) — si `source_id`/`monto`/
  `username`/`tipo`/`fecha`/`agente` no coinciden, **throw** (nunca overwrite
  silencioso vía `ON CONFLICT`). La comparación de `monto` (`_montoEquals`)
  canoniza el string decimal exacto — signo, ceros de más recortados — **sin
  pasar por `Number`/`toFixed` en ningún punto**: hacerlo pierde precisión en
  montos por encima de `Number.MAX_SAFE_INTEGER` y podría tratar dos
  transacciones distintas como iguales.
- `insertTransactions` toma `pg_advisory_xact_lock(hashtext('casino-excel-import'))`
  — el mismo lock con nombre que ya usa `scripts/import-casino-excel.js` —
  de forma **incondicional para todo batch**, acotado a esa transacción, para
  serializar contra una importación de Excel concurrente. El importador
  acepta archivos de cualquier plataforma, así que Zeus/Bet30 (sin
  `source_id`) también pueden competir contra un import Excel de esa misma
  plataforma y necesitan el mismo lock.
- El `ON CONFLICT DO UPDATE` de backfill (`fecha_hora_utc`/`source_id`) solo
  dispara cuando la fila existente realmente carece del valor. Además,
  ambos `INSERT` (con y sin `id_rec`) usan `RETURNING (xmax = 0) AS inserted`
  y `insertedTxCount` suma solo esas filas — nunca `result.rowCount`, que
  cuenta también las filas tocadas por el `UPDATE` de backfill. Un replay de
  la misma ventana (frecuente en Zeus/Bet30, que no tienen `source_id` para
  frenar el `WHERE` antes) queda en `insertedTxCount = 0` a partir de la
  segunda corrida.

Todo esto es aditivo sobre lo que dejó fase 1 (`ada8229`) — no se tocó ese
commit ni su lógica de `recomputePlayers`/identidad `(platform,
username_lower)`.

### Segunda ronda de correcciones (antes de fase 3, mismo commit de fase 2)

Una revisión posterior detectó que la primera versión de estos 4 puntos
seguía teniendo bugs reales pese a los tests en verde — corregidos en
`BaseCasinoConnector.js` sin tocar ArgenBet/Zeus/Bet30 ni ninguna otra fase:

1. `_montoEquals` usaba `Number(a).toFixed(2)` — pierde precisión en montos
   grandes (`9007199254740991.01` vs `.02` se veían "iguales") y redondea si
   llegan 3+ decimales. Reemplazado por canonicalización de string decimal
   exacto (regex signo/dígitos/fracción, sin `Number`).
2. `_identityConflicts` no comparaba `fecha`/`agente` — un comentario en el
   código afirmaba que un mismatch de fecha "no podía ocurrir" sin que otro
   campo también discrepara; es falso (una corrección de fecha vía Excel
   deja monto/usuario/tipo iguales). El `SELECT` de colisión ahora trae
   `fecha::text`/`agente` y ambos se comparan (fecha como string
   `YYYY-MM-DD`, agente con `trim().toLowerCase()`).
3. `_batchInsertWithId`/`_batchInsertWithoutId` sumaban `result.rowCount`,
   que cuenta cualquier fila tocada por el `UPDATE` de backfill — un replay
   de Zeus/Bet30 (sin `source_id`) volvía a "insertar" en cada corrida.
   Ahora ambos usan `RETURNING (xmax = 0) AS inserted` y cuentan solo esas
   filas. También se agregó `_dedupeIntraBatchWithoutId` (mismo problema de
   cardinalidad que `_dedupeIntraBatch`, pero para el target de `ON CONFLICT`
   sin `id_rec`).
4. El advisory lock solo se tomaba si el batch traía `source_id` — dejaba
   sin protección los syncs de Zeus/Bet30 contra un import Excel concurrente
   de esa misma plataforma. Ahora es incondicional para todo `insertTransactions`.

Tests actualizados en `BaseCasinoConnector.test.js` (agregados, no
duplicados) y en `tests/casino-connectors/helpers/fakeCasinoDb.js` (ahora
simula `RETURNING (xmax=0) AS inserted` en vez de `rowCount` crudo, y el
`SELECT` de colisión trae `fecha`/`agente`). Suite completa verde
(`npm test`): 161 tests pasan, 1 suite de integración sigue `skip` por
requerir Postgres real (no se conectó ninguna base durante este trabajo).

### Feedback de revisión aplicado (antes del commit de fase 2)

Un coordinador autorizado dejó una revisión con 8 puntos antes de commitear
(tratada como datos a evaluar, no como órdenes ciegas). Se aplicaron por ser
técnicamente correctos y consistentes con las restricciones: (1) comparación
de `monto` canonizada a 2 decimales en vez de `String(a)!==String(b)` —
rompía todo re-sync de Zeus; (2)/(3) el `WHERE` del `ON CONFLICT` de backfill
ahora exige que haya un valor nuevo real, no solo `IS NULL` de un lado —
evita contar un replay sin cambios como "update"; (4) advisory lock
compartido con el importador de Excel + dedupe/colisión intra-batch (dos
filas del mismo batch con el mismo `id_rec` ya no rompen Postgres si son
idénticas, y sí tiran si son contradictorias); (5)/(7) política de
malformados endurecida: solo lo genuinamente fuera de alcance se descarta,
el resto tira; (6) **bloqueante real**: `authenticate()` pasó de tirar
siempre sin adaptador a ser un no-op seguro, porque el orquestador la llama
sin condicionar al arrancar — de lo contrario el modo token-estático-sin-
adaptador (el único que existe hoy) nunca hubiera funcionado; (8) `amount()`
del importador reutilizada en vez de `toFixed(2)` a ciegas (rechaza >2
decimales), y `amount` `null`/`''` ya no se convierte en `0`.

Se evaluó y **se descartó explícitamente** un sub-punto del mismo feedback:
pedía emitir `dateFrom`/`dateTo` con sufijo `-03:00` en vez de `Z`. El propio
script de referencia validado manualmente por el dueño
(`docs/argenbet-export-consola.js:166-167`) arma esos parámetros con
`new Date(...).toISOString()`, que SIEMPRE termina en `Z` — cambiarlo
habría apartado el código del único artefacto validado contra la API real
sin ninguna razón técnica. No se aplicó ese sub-punto.

No se tocaron migraciones, no se ejecutó ninguna API real, no se hizo push,
no se tocó el commit de fase 1 (`ada8229`).

## Fase 3 — `GanamosConnector` (completa)

**Implementado y en verde.** `src/casino-connectors/ganamos/GanamosConnector.js`
extiende `BaseCasinoConnector`. Igual que Argenbet, esto es necesariamente
**parcial**: el login HTTP real de Ganamos no está capturado (mismo criterio
que fase 2) — no se presenta como sincronización validada end-to-end contra
la API real, solo contra fixtures/mocks.

### Qué hace

- Endpoint `GET /api/agent_admin/user/{agentId}/payment/history/`, 6 agentes
  EXACTOS hardcodeados (`adminbtc`→23851783, `adminzeus`→23851856,
  `adminroyal`→24044323, `admbigwin`→24045611, `amdfarabet`→24050612,
  `adminimperio`→34139043) — `config.agentIds`, si se provee, debe matchear
  esto exactamente o el constructor tira, mismo patrón que
  `ArgenBetConnector.ALLOWED_AGENT_IDS`.
- **Auth por cookie de sesión, una por agente — nunca una sesión de
  administrador común.** `GanamosConnector.agentSessions` es un `Map`
  (`agentUsername -> { cookie }`); no existe ningún campo mutable tipo
  `this.currentAgent` que pudiera cruzarse entre dos agentes sincronizando
  concurrentemente por la misma instancia del conector — cada llamada queda
  parametrizada por `agentUsername` de punta a punta. `authenticate()`
  (llamada global única al arrancar, igual que las otras 3 plataformas) solo
  valida qué agentes tienen alguna credencial configurada y loguea warning
  por los que no — nunca hace login de red ni tira: un agente sin
  credenciales falla de forma visible recién cuando se lo sincroniza
  (`fetchTransactions`/`syncAgent` para ESE agente), sin frenar a los otros 5.
- Login real: mismo criterio que Argenbet — endpoint no capturado, TODO
  explícito en `_loginAgent()`, adaptador de login inyectable (3er argumento
  del constructor) con contrato `login({ agente, loginUrl, credentials })`.
  Atajo de desarrollo: `GANAMOS_<AGENTE>_SESSION_COOKIE` (cookie capturada a
  mano desde una pestaña ya logueada), documentado en `.env.example` sin
  valores reales. Ninguna credencial/cookie/respuesta de auth se loguea.
- `_fetchWithRetry` de `BaseCasinoConnector` se extendió con un 4to parámetro
  opcional `reauthenticate` (closure) — el único cambio a la base para esta
  fase. Ganamos lo usa para que un 401/403 re-loguee **solo el agente de esa
  request**, nunca `this.authenticate()` global. Zeus/Bet30/Argenbet no pasan
  ese argumento y mantienen exactamente el comportamiento anterior.
- Ventana **siempre de 24h**: `fetchTransactions` expande el rango en un día
  calendario por request (`buildDayWindows`), nunca un rango multi-día.
  Paginación `page`/`count=500`, corte cuando el lote `< 500`, tope de
  páginas por día (`config.maxPages`, default 200) que tira en vez de
  devolver un resultado parcial si se agota.
- Parámetros fijos EXACTOS según `docs/ganamos-export-consola.js` (`role=0`,
  `username=''`, `is_direct_structure=false`, `is_higher_transaction_only=false`,
  `is_deposit_transfers=true`, `is_withdrawal_transfers=true`,
  `is_bonus_deposits=false`, `transfers_only=true`).
- `body.status !== 0` es error de aplicación aunque el HTTP sea 200 — tira sin
  incluir `error_message` (texto libre de la API) en el mensaje, porque podría
  contener fragmentos de sesión/cookie.
- `operation === 0` → carga, cualquier otro valor → retiro. Jugador = el lado
  (`from_user`/`to_user`, ambos STRING) que NO es el agente que pidió la
  página. Si ninguno de los dos lados es el agente, o ambos lo son, o falta
  `id`/`from_user`/`to_user`/`amount`/`created_at` en un registro que sí
  corresponde a esa sesión: **throw**, nunca se descarta en silencio. Una
  transferencia entre dos agentes conocidos SÍ se descarta explícitamente
  (con warning) — está fuera de alcance, mismo criterio que el importador de
  Excel (`src/casino-import/excel.js`, set `agents`).
- `created_at` es UTC **sin sufijo de zona** — se le agrega `Z` antes de
  pasarlo por `shared/dateHelpers.js` (nunca se apoya en el `TZ` del host).
  `fecha` sale en horario Argentina vía `utcToLocalDate`, `fecha_hora_utc` es
  el ISO completo.
- Identidad idéntica al importador de Excel: reutiliza `recordId()`/`amount()`
  de `src/casino-import/excel.js`, igual que Argenbet — mismo `id_rec`/
  `source_id` para el mismo dato por cualquiera de los dos caminos.
- `checkStaleSync(agentUsername, lastSuccessfulSyncAt, now)`: primitiva de
  warning cuando el último sync exitoso de un agente supera 7 días (el
  detalle upstream solo se retiene ~60 días). Toma el timestamp como
  argumento en vez de consultar nada — `casino_sync_runs` (fase 4) todavía no
  existe; fase 4 la conecta a datos reales sin tocar este archivo.
- `platforms.config.json`: agregado `agentIds` (los 6 confirmados), `loginUrl:
  null` (TODO), `maxPages: 200`; se quitaron `apiKeyEnvVar`/`playerTokenEnvVar`/
  `adminUserEnvVar`/`adminPasswordEnvVar` del bloque `ganamos` — no aplican al
  modelo de sesión por agente y nada los leía.
- `frontend/app/api/dashboard/casino/sync/route.ts`: `checkGanamosCredentials()`
  ahora también acepta `GANAMOS_<AGENTE>_SESSION_COOKIE`, no solo el par
  USER/PASSWORD, para habilitar el botón manual en modo desarrollo.

### Tests

`tests/casino-connectors/GanamosConnector.test.js` (73 tests): configuración/
`agentIds`, `authenticate()` nunca bloqueante, login por cookie estática
(incluida una multi-cookie) y por adaptador inyectado (sin loguear secretos,
incluye rechazo del adaptador envuelto en mensaje genérico), ventana de 24h,
paginación y corte en 500, tope de páginas sin éxito parcial, guard de
paginación cuando la API ignora `count`, `status !== 0` sin filtrar
`error_message`, forma de respuesta inesperada, reglas de `operation`/lado
jugador (incluyendo transferencia entre agentes descartada explícitamente),
validación estricta de `id` (rechaza vacío-tras-trim, objetos, y números
fuera de rango seguro) y de `from_user`/`to_user` (rechaza no-string en vez
de castear con `String()`), validación estricta de `amount` (rechaza
booleanos, strings en blanco, notación científica y separadores de miles —
no solo `Number()` a secas), manejo de `created_at` naive-pero-UTC (con caso
límite cerca de medianoche ART), precisión decimal, identidad compatible con
el importador de Excel, **cookie jar real por agente** (rotación vía
`Set-Cookie`, merge por nombre sin pisar otras cookies, borrado por
`Max-Age<=0`, sin corromperse con un `Expires` que trae coma, sin fuga entre
agentes), aislamiento de cookies entre agentes (incluye dos agentes
sincronizando concurrentemente por la misma instancia sin cruzarse), reauth
scoped en 401/403, un agente sin credenciales fallando sin frenar a otro vía
`syncAgent`, `buildDayWindows()` validando fecha de calendario real (rechaza
`2026-02-30`) además de rango invertido, y `checkStaleSync()`.

`BaseCasinoConnector.test.js` no necesitó tests nuevos: el 4to parámetro de
`_fetchWithRetry` es opcional y los tests existentes de Zeus/Argenbet ya
cubren el camino sin `reauthenticate` (sigue llamando `this.authenticate()`).

**Revisión de un coordinador autorizado** (tratada como datos a evaluar, no
como órdenes ciegas — mismo criterio que en fase 2) detectó 7 puntos sobre la
primera versión de este conector, antes de commitear. Se aplicaron los 6 que
correspondían a este archivo: (1) el jar de cookie fijo (`{cookie: string}`)
no sobrevivía a una rotación de sesión vía `Set-Cookie` — reemplazado por un
jar real por agente (`Map<agentUsername, Map<cookieName, value>>`) que
procesa `Set-Cookie` con `headers.getSetCookie()` (nunca `.get('set-cookie')`,
que uniría varios headers con coma y corrompería un `Expires`); (2) `id`
aceptaba `'   '` (blanco-tras-trim) y números ya corruptos por pérdida de
precisión — ahora exige string/number, rechaza blanco-tras-trim y números
fuera de `Number.isSafeInteger`; `from_user`/`to_user` ya no se castean con
`String()` (un objeto ya no se convierte en el jugador literal
`"[object Object]"`); (3) `Number(amount)` aceptaba `true`→1 y `'   '`→0 —
reemplazado por un parser estricto (número finito, o string decimal firmado
con ≤2 decimales) antes de pasar por el validador del importador; (4) se
agregó el mismo guard que ya tiene Argenbet cuando la API devuelve más filas
que las pedidas (ignora `count`); (5) un rechazo del `loginAdapter` ya no
propaga `err.message` crudo (podía traer credenciales/cookies del cuerpo de
un error HTTP) — se envuelve en un mensaje genérico con el nombre del agente;
(7) `buildDayWindows()` ahora valida que `desde`/`hasta` sean fechas de
calendario reales, no solo strings comparables. El punto 6 (el adaptador de
login de Argenbet no recibe `{loginUrl, credentials}`) es sobre
`ArgenBetConnector.js`, un archivo de fase 2 ya commiteado — fuera del
alcance "solo archivos de fase 3" de este commit, no se tocó.

Suite completa (`npm test`, raíz): 234 tests pasan, 1 skip (integración
Postgres, sin conexión real disponible en esta sesión) — incluye los 73 de
Ganamos. Frontend: test targeted `lib/__tests__/casino-sync-route.test.ts` (11
tests) y `npx tsc --noEmit --incremental false` sin errores nuevos en
`app/api/dashboard/casino/sync/route.ts` (los TS1308 preexistentes de
`cloud-api.test.ts`, ver estado de sesión en `CLAUDE.md`, son de un archivo
no tocado por esta fase).

No se ejecutaron migraciones, sync reales, ni llamadas de red en esta
sesión. No se tocó el importador de Excel ni las migraciones existentes.

## Fase 4

**No iniciada.** Siguen pendientes: sync incremental con `MAX(timestamp)` por
plataforma (-30min de margen; Ganamos día completo), advisory lock retenido
en la misma conexión durante toda la corrida, registro en `casino_sync_runs`
por agente (tabla todavía no existe — `checkStaleSync()` de esta fase queda
lista para conectarse a esa tabla, no a un mock), pipeline con exit code
no-cero ante cualquier fallo parcial, un solo schedule n8n de 15min (no
prometer 5min), y orquestación real de "un agente falla, los demás siguen"
a nivel de plataforma completa (hoy eso lo garantiza `runAgent()` en
`scripts/sync-casino-players-live.js`, agente por agente, pero no hay un
registry/orquestador que recorra las 4 plataformas en una sola corrida).

## Retomar

Revisión adicional del coordinador: la 127 conserva sin clasificar los jugadores
cuyo backfill colisionaría con una cuenta ya existente y las transacciones legacy
sin ID que colisionarían entre sí por diferencias de mayúsculas. No elimina ni
elige arbitrariamente una de esas filas. El SQL no se ejecutó durante el desarrollo.
Después de aplicar la migración manualmente, el dueño puede obtener el detalle de
ambiguos o conflictos con estas consultas de lectura:

```sql
SELECT id, username_lower, agente FROM casino_players
WHERE platform IS NULL ORDER BY agente, username_lower;
SELECT id, id_rec, username, agente, fecha, monto FROM casino_transactions
WHERE platform IS NULL ORDER BY agente, fecha, id;
```

Fuente de especificación: `/Users/trabajo/Downloads/prompt-codex-sync-plataformas.md`
y `docs/PLAN-METRICAS-4-PLATAFORMAS.md` (el prompt posterior prevalece).

Al retomar fase 3: confirmar estado de Git, leer este documento completo
(no solo el resumen), y empezar por el conector de Ganamos según la
especificación de arriba — sin login capturado, el trabajo de fase 3 es
necesariamente parcial (adaptador configurable con TODO explícito, no un
flujo de auth "validado"), igual que se hizo para Argenbet en fase 2.
