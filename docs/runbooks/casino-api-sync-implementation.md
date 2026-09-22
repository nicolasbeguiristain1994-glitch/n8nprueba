# Sincronización API de cuatro plataformas — estado de implementación

Actualizado: 2026-09-21, sesión Claude Max (retomada desde el checkpoint de la
sesión anterior, que había agotado su ventana de 5 horas).

## Estado: cuatro fases implementadas; instalación y login real pendientes

La guía de entrega vigente está en [casino-api-sync-handoff.md](casino-api-sync-handoff.md).
Las secciones siguientes conservan el detalle técnico por fase; las cifras
de pruebas de cada revisión son históricas. La validación final fue de 312
pruebas raíz y 856 de frontend aprobadas, con siete omisiones de integración
y TypeScript sin errores. No se aplicaron migraciones ni se consultaron APIs reales.

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

**Implementada.** Resumen de lo que cambió, qué del plan ya estaba resuelto,
qué falta cerrar, y el orden de migraciones.

### Qué ya estaba resuelto antes de esta fase

- El punto pendiente que quedó anotado al cierre de fase 3 ("el adaptador de
  login de Argenbet no recibe `{loginUrl, credentials}`") — cerrado en esta
  fase: `ArgenBetConnector.authenticate()` ahora lee `ARGENBET_ADMIN_USER`/
  `_PASSWORD` (vía `config.adminUserEnvVar`/`adminPasswordEnvVar`) y llama
  `loginAdapter.login({ loginUrl, credentials: { user, password } })`, igual
  que `GanamosConnector._loginAgent()`. Su rechazo se envuelve en un mensaje
  genérico (nunca `err.message` crudo, que podía traer credenciales).
- Validación estricta de `id`/`amount` en `ArgenBetConnector.normalizeTransactions`
  — antes usaba `Math.abs(Number(item.amount))` (acepta `true`→1, `'   '`→0,
  notación exponencial) y no acotaba el tipo de `id`. Ahora usa el mismo
  criterio que `GanamosConnector` (parser estricto de amount, `id` sólo
  string/number-safe-integer).

### Qué se construyó

1. **`src/casino-connectors/shared/incrementalWindow.js`** — checkpoint POR
   AGENTE (`MAX(fecha_hora_utc) WHERE platform=$1 AND agente=$2`, nunca
   `platform` a secas): el fallo de un agente nunca puede "taparse" porque
   otro agente de la misma plataforma sí sincronizó — cada agente sólo avanza
   su propio checkpoint, y sólo con datos que de verdad se COMMITearon
   (`insertTransactions` es atómico por llamada).
   **Corrección posterior (revisión de recuperación/idempotencia):** el
   `MAX(fecha_hora_utc)` NO es, por sí solo, un checkpoint completo — es un
   checkpoint de "qué transacciones se COMMITearon", no de "qué corrida quedó
   totalmente resuelta". `BaseCasinoConnector.syncAgent()` hace
   `insertTransactions()` y `recomputePlayers()` como dos llamadas a la DB
   separadas; si `recomputePlayers()` falla DESPUÉS de que `insertTransactions()`
   ya comiteó, el próximo `--auto` calculaba `desde` como
   `MAX(fecha_hora_utc) - 30min` — un rango que queda enteramente DESPUÉS de lo
   que falló, perdiendo la re-ejecución del recompute para ese rango. Lo mismo
   le pasaba a un backfill histórico chunked: si el chunk N fallaba, nada
   impedía que el chunk N+1 corriera igual, ni que un `--auto` posterior
   ignorara el hueco. `resolveIncrementalRange()` ahora SÍ usa
   `casino_sync_runs` (migración 128) como checkpoint de recuperación:
   `_earliestUnresolvedFailureDesde()` busca la corrida `failed` más antigua
   para ese `(platform, agente)` cuyo rango NO esté completamente contenido
   dentro de una corrida `ok` POSTERIOR, y ensancha `desde` hacia atrás hasta
   cubrirla — un éxito posterior más chico (p.ej. un re-run manual de un solo
   día) nunca "cierra" un hueco más amplio, sólo un éxito que contenga el rango
   completo lo hace. `scripts/lib/casino-sync-orchestrator.js` además deja de
   correr chunks posteriores para un agente una vez que uno falla (antes
   seguía intentando los siguientes chunks igual), y adjunta el conteo real de
   transacciones insertadas (`err.insertedTxCount`, ver
   `BaseCasinoConnector.syncAgent()`) a la fila `failed` de `casino_sync_runs`
   en vez de dejarla en `null`. Ganamos tiene su propia variante: el ancla de
   recuperación no es sólo `MAX(fecha)` sobre `casino_transactions` (que un día
   sin transacciones deja intacto, aunque ese día se haya sincronizado bien)
   sino el máximo entre esa fecha, el `range_hasta` de la última corrida `ok`
   (aunque haya insertado cero transacciones), y el `range_desde` de cualquier
   falla no resuelta — así un primer intento que falló ayer, o un día
   exitoso-pero-sin-movimientos, se re-consultan correctamente en vez de saltar
   directo a "solo hoy". Ver `tests/casino-connectors/incrementalWindow.test.js`
   y `tests/casino-connectors/casino-sync-orchestrator.test.js` para los casos
   cubiertos.
   Ganamos usa siempre el día actual completo (nunca sub-día — la API no
   acepta rangos >24h). Bootstrap (primer sync sin datos previos) documentado
   por plataforma en `AUTO_BOOTSTRAP_DESDE` — explícito, nunca un
   `2020-01-01` silencioso; Ganamos no tiene entrada ahí a propósito (no hay
   "primera fecha con datos" significativa con retención de ~60 días — un
   backfill histórico de Ganamos es responsabilidad del dueño, vía Excel o
   `--desde/--hasta` manual).
2. **`src/casino-connectors/shared/dateHelpers.js`** — `buildApiDateRange()`:
   Zeus/Bet30 (H7, D4) ahora aceptan tanto `YYYY-MM-DD` (histórico/manual)
   como un timestamp ISO exacto (incremental), formateado correctamente a
   hora local ART — nunca `toISOString() + ' 00:00:00'` concatenado, que
   ignoraba la hora real.
3. **`src/casino-connectors/shared/platformLock.js`** — advisory lock de
   SESIÓN (`pg_try_advisory_lock`/`pg_advisory_unlock`) en un único client
   retenido desde antes de crear el conector hasta el final de la corrida.
   `release()` destruye la conexión (no la devuelve limpia al pool) si el
   unlock falla. Nunca se sostiene durante una llamada HTTP — sólo protege el
   run completo desde el lado de Postgres.
4. **`scripts/lib/casino-sync-orchestrator.js`** — núcleo testable
   (pool/createConnector/clock inyectables, sin leer `.env` ni conectar al
   importar). `runOrchestrator()`: toma el lock → si ya está tomado, sale
   limpio (`skipped:true, ok:true`) y opcionalmente deja un registro
   `status='skipped'` en `casino_sync_runs` que NUNCA tapa el último éxito/error
   real (ver `sync-status` más abajo) → construye el conector y autentica
   (fallo acá se registra como corrida `agente=NULL` fallida, nunca un crash
   silencioso) → por cada agente, registra `running` en `casino_sync_runs`
   ANTES de llamar `syncAgent()`, y `ok`/`failed` en el mismo lugar al
   terminar (try/catch, nunca un `finally` que pueda dejar una fila en
   `running` para siempre salvo crash real del proceso) → libera el lock
   siempre (`finally`). Usado tanto por `scripts/sync-casino-players-live.js`
   (CLI, ahora un wrapper delgado con guard `require.main === module`) como
   por `scripts/pipeline-diario.js` (in-process, las 4 plataformas).
5. **`db/migrations/128_casino_sync_runs.sql`** — tabla `casino_sync_runs`
   (`platform`, `agente` nullable, `started_at`, `finished_at`, `status`
   `running|ok|failed|skipped`, `tx_inserted`, `range_desde`/`range_hasta`,
   `error` ya sanitizado). Si no existe, el orquestador falla fuerte con un
   mensaje explícito (`MISSING_TABLE_HINT`) en vez de correr sin bitácora.
6. **`scripts/pipeline-diario.js`** — reescrito: las 4 plataformas (antes sólo
   Zeus/Bet30) leídas de `src/config/platforms.config.json` vía
   `getConfigAgents()` (zeus/bet30 declaran `agents: [...]`; ganamos/argenbet
   usan las claves de `agentIds`, los únicos agentes que sus conectores
   aceptan) — nunca hardcodeadas en el script ni inferidas de la DB. Exit
   code `!= 0` si CUALQUIER plataforma falla, y también si falla la
   segmentación o el recompute de prioridades (antes `failOk: true` los
   dejaba sin afectar el exit code — corregido, era exactamente el tipo de
   "verde falso" que el plan pide evitar). `runPipeline()`/`runAllPlatformSyncs()`
   exportados para pipeline-diario.test.js y para el endpoint de cron.
7. **`frontend/app/api/cron/casino-sync/route.ts`** (nuevo) — único disparador
   programado (D4: "elegir uno solo"). Protegido con `CRON_SECRET` +
   `timingSafeEqual` (mismo secreto que `/api/contacts/recompute-priorities`).
   Ejecuta `pipeline-diario.js --json` como proceso hijo (`process.execPath`,
   argv array, nunca shell) y ESPERA el resultado real (parseado de la línea
   `PIPELINE_RESULT_JSON:...` que el script imprime al terminar) antes de
   responder — nunca "202 accepted" seguido de un fallo invisible. `POST
   /api/dashboard/casino/sync` queda EXCLUSIVAMENTE para el botón manual
   (una plataforma, bajo demanda); ambos pasan por el mismo lock, así que no
   pueden pisarse, pero sólo uno está programado.
8. **`n8n/workflow-specs/WF-030-Casino-Daily-Sync.json`** — cadencia
   `*/15 * * * *` (antes diario 04:00 UTC), apunta a
   `/api/cron/casino-sync` con header `x-cron-secret`, timeout de nodo
   subido a 10 min (el pipeline corre en foreground). No se encontró ningún
   otro cron/scheduled trigger apuntando a sync de casino en el repo
   (`railway.toml`, `.github/`) — este workflow sigue siendo el único.
   **El dueño debe aplicar manualmente el workflow actualizado en su
   instancia de n8n** (este repo sólo versiona la especificación JSON, no la
   publica) y agregar la env var `CASINO_CRON_SECRET` en n8n con el mismo
   valor que `CRON_SECRET` en el servidor.
9. **`frontend/app/api/dashboard/casino/sync-status/route.ts`** (nuevo) —
   `GET`, protegido por `checkPermission(dashboard, read)`. Expone el último
   estado real (`ok`/`failed`/`running`) por `(platform, agente)` desde
   `casino_sync_runs`, excluyendo `skipped` del cálculo de "último estado
   real" (un skip nunca debe tapar el último éxito/error genuino) pero
   exponiéndolo aparte como `lastSkipAt`. El dashboard consume este endpoint desde `CasinoSyncStatusBar.tsx`,
   muestra errores de plataforma y agentes sin historial, y se actualiza
   cada 60 segundos. No se rediseñó el dashboard.
10. **`frontend/app/api/admin/test-casino-sync/route.ts`** (auditoría pedida
    explícitamente) — corregido: antes SIEMPRE respondía `ok: true` salvo que
    `spawn()` tirara sincrónicamente (algo que casi nunca pasa); ahora `ok`
    es `true` únicamente si el proceso hijo terminó con código 0 (nunca en
    timeout, código != 0, o error de spawn — antes esos casos también volvían
    `ok:true`). Usa `process.execPath` (no `spawn('node', ...)`, que dependía
    de que "node" existiera en el `$PATH` del proceso) y valida `platform`
    contra las 4 soportadas antes de spawnear nada.

### Revisión del coordinador aplicada (antes del commit de fase 4)

Igual que en fases 2/3, una revisión de un coordinador autorizado (tratada
como datos a evaluar, no como órdenes ciegas) encontró varios puntos sobre
la primera versión de los módulos de fase 4. Se aplicaron todos antes de
commitear:

1. **Ganamos usaba el día calendario UTC, no ART** para `hasta`/`desde`
   (`now.toISOString().slice(0,10)`) — a las 01:00 UTC (22:00 ART del día
   anterior... hasta 00:00 ART) calculaba el día siguiente equivocado.
   Corregido con `utcToLocalDate`.
2. **Ganamos ignoraba el último sync exitoso y siempre pedía sólo "hoy"** —
   un run faltante o un crash perdía silenciosamente lo que cayó en el
   medio, dentro de una ventana que igual estaba dentro de los ~60 días de
   retención. Corregido: recupera día a día desde el último `MAX(fecha)`
   comprometido para ese agente, con un tope duro en `GANAMOS_RETENTION_DAYS`
   (60) y warning explícito cuando se activa (nunca un truncamiento
   silencioso), y warning adicional cuando el gap supera 7 días pero sigue
   siendo recuperable.
3. **`resolveIncrementalRange()` se llamaba fuera del try/catch por agente**
   en el orquestador — un fallo al resolver la ventana de UN agente abortaba
   la plataforma entera sin dejar registro. Corregido: la resolución de rango
   ahora vive dentro del mismo try/catch que la sincronización, por agente.
4. **Sin run "padre" por plataforma** — un fallo en la construcción del
   conector o `authenticate()` sólo se registraba de forma ad-hoc. Corregido:
   `runOrchestrator()` ahora crea un run `agente=NULL` que cubre TODA la
   corrida (desde antes del conector hasta después del último agente) y lo
   cierra `ok`/`failed` — visible en el dashboard como `platformRun`.
5. **Filas `running` abandonadas por un crash no se limpiaban nunca** —
   corregido: al re-adquirir el lock (que prueba, por exclusión mutua, que
   ninguna corrida legítima puede seguir en curso), cualquier `running`
   previo de esa plataforma se marca `failed` con nota explícita
   ("abandoned").
6. **`GanamosConnector.checkStaleSync()` nunca se llamaba** — corregido:
   el orquestador consulta el último `finished_at` con `status='ok'` de
   `casino_sync_runs` para ese agente y se lo pasa.
7. **Validación de entradas ausente** — `chunkDays`/`concurrency`
   inválidos se clampeaban en silencio a 1; un rango `desde > hasta` en
   `_buildDateChunks` devolvía `[]` (que el caller reportaba como `ok:true`
   sin haber sincronizado nada); una lista de agentes vacía también
   reportaba `ok:true`. Los tres ahora son fallos explícitos.
8. **CLI (`sync-casino-players-live.js`) seguía infiriendo agentes con un
   `SELECT DISTINCT agente FROM casino_players`** — contradecía el requisito
   de que la config sea la única fuente. Corregido: usa `getConfigAgents()`
   por defecto; `--agentes` valida contra esa lista y rechaza nombres no
   configurados en vez de pasarlos sin chequear.
9. **`pipeline-diario.js`'s `lastTimestamp` usaba el `hasta` SOLICITADO**, no
   una consulta real — una ventana con cero transacciones nuevas (o un
   agente fallido) igual reportaba "al día". Corregido: consulta real
   `MAX(fecha_hora_utc)` por plataforma después de la corrida.
10. **`runPipeline()` no permitía inyectar los pasos 5/6** para tests —
    corregido: `deps.runSegmentacion`/`deps.runRecomputePrioridades` son
    inyectables (default: las implementaciones reales).
11. **Un fallo de `getConfigAgents()` sólo vivía en el summary en memoria** —
    corregido: se persiste vía `recordPlatformFailure()` en
    `casino_sync_runs` antes de seguir con las demás plataformas.
12. **El endpoint de cron confiaba en el JSON del hijo sin cruzarlo con el
    código de salida real** — un summary con `ok:true` pero código != 0 (o
    `null` por señal) se habría reportado como éxito. Corregido: `ok` exige
    `code === 0 && summary.ok === true`. También: buffer de stdout acotado
    (256KB — un histórico grande no debe crecer sin límite en memoria) y
    timeout de 9 minutos que mata el proceso y responde 504 en vez de dejar
    la request colgada indefinidamente.
13. **El endpoint de status perdía el último éxito de un agente actualmente
    fallido**, no distinguía un empate de timestamp de forma determinística,
    omitía agentes configurados sin historial, y detectaba "tabla faltante"
    por texto del mensaje de error (falso positivo/negativo posible).
    Corregidos los 4: `lastSuccessfulAt` por agente vía `MAX(finished_at)
    FILTER (status='ok')`, desempate `id DESC`, `never_synced` explícito
    para agentes configurados sin runs, chequeo por código Postgres `42P01`.
14. **La UI del dashboard no mostraba nada** — pedido explícito del brief
    ("exponé el último estado en el dashboard"), no cumplido con sólo el
    endpoint. Se agregó `CasinoSyncStatusBar.tsx` (ver más abajo).

Suite ampliada tras la revisión: 289 tests pasan en raíz (antes 270), 843 en
frontend (antes 835). `npx tsc --noEmit --incremental false` sin errores.

### Qué falta (no inventado, documentado para el dueño)

- **Login real de Argenbet y Ganamos** — sigue siendo el mismo TODO explícito
  de fases 2/3 (`ArgenBetConnector.authenticate()` /
  `GanamosConnector._loginAgent()`). Fase 4 no lo resuelve ni lo bloquea: con
  sólo `ARGENBET_PLAYER_TOKEN` (estático) o `GANAMOS_<AGENTE>_SESSION_COOKIE`
  (dev), el sync incremental funciona igual que antes, rotando el token/cookie
  a mano. Sigue faltando exactamente lo mismo que en fase 2/3: URL de login,
  método HTTP, forma del body, y dónde viene el token/cookie de vuelta — para
  ambas plataformas. No se inventó ninguno de los dos.
- ~~Badge visual en el dashboard~~ — **hecho** tras la revisión del
  coordinador: `frontend/components/dashboard/CasinoSyncStatusBar.tsx`
  (nuevo), montado en `Dashboard.tsx` justo debajo del header. Consume
  `GET /api/dashboard/casino/sync-status`, refresco propio cada 60s
  (independiente del auto-refresh de datos de negocio), un badge por
  plataforma (running/ok/failed/never_synced), agentes con error nombrados
  (nunca ocultos), último éxito por agente, y un banner de error visible si
  el endpoint mismo falla. No es un rediseño del dashboard.
- **Aplicar el workflow n8n actualizado** — el dueño debe importarlo/aplicarlo
  a mano en su instancia de n8n (este repo no lo publica) y desactivar
  cualquier otro disparador manual que hubiera dejado corriendo contra
  `/api/dashboard/casino/sync` en un cron externo (no se encontró ninguno en
  este repo, pero Railway/n8n pueden tener triggers configurados fuera del
  repo que no son visibles desde acá).
- **Validación real contra el panel** — la cifra de referencia de fase 2
  (adminroyal, agosto 2026: 1.715 tx, 184 jugadores, depósitos 22.898.554,00,
  retiros 14.920.991,67) sigue pendiente de una corrida real contra
  producción, que corre el dueño — no se ejecutó ninguna sincronización real
  en esta sesión (sólo mocks/fixtures, según instrucción explícita).

### Migraciones — orden para el dueño

1. `126_casino_excel_import.sql`, si aún no está aplicada: es requisito
   previo de la 127. No volver a aplicarla después de 127.
2. `127_casino_players_platform_identity.sql` (fase 1), después de 126.
3. **`128_casino_sync_runs.sql` (esta fase)** — requerida por
   `scripts/lib/casino-sync-orchestrator.js` antes de correr cualquier sync
   de fase 4 (CLI, pipeline o los endpoints nuevos). Sin ella, el
   orquestador falla fuerte con un mensaje explícito en vez de correr sin
   bitácora.

### Variables de entorno nuevas

- `CRON_SECRET` — ya existía (protege `/api/contacts/recompute-priorities`);
  ahora también protege `POST /api/cron/casino-sync`. No hace falta un
  secreto nuevo, es el mismo.
- `CASINO_CRON_SECRET` (env var de **n8n**, no del servidor) — debe
  configurarse en la instancia de n8n con el mismo valor que `CRON_SECRET`
  en el servidor, para que el header `x-cron-secret` del workflow lo envíe.

### Tests (todos con HTTP/PG mockeados, sin tocar una DB real)

- `tests/casino-connectors/incrementalWindow.test.js` — watermark por agente,
  aislamiento entre agentes de la misma plataforma, bootstrap documentado
  (no `2020-01-01`), Ganamos día-actual-completo, checkpoint que no se pierde
  en un día sin transacciones.
- `tests/casino-connectors/platformLock.test.js` — acquire/skip limpio,
  unlock, destroy-on-unlock-error, idempotencia de `release()`, aislamiento
  entre plataformas.
- `tests/casino-connectors/casino-sync-orchestrator.test.js` — éxito total,
  fallo parcial (summary `ok:false` con detalle), fallo de
  constructor/`authenticate()` registrado con `agente=NULL`, 10 corridas
  idénticas seguidas con `txInserted=0` desde la segunda, segunda corrida
  concurrente skip limpio sin tocar el conector, lock liberado incluso ante
  error (permite una corrida siguiente), error explícito si
  `casino_sync_runs` no existe, modo `--auto` resolviendo ventana por agente.
- `tests/pipeline-diario.test.js` — las 4 plataformas en el resumen, una
  plataforma cayéndose no frena a las demás, fallo por-agente reportado
  (nunca "ok" con un agente roto adentro), skip reportado como `'skip'` (ni
  ok ni error), fallo de segmentación propaga `ok:false` aunque las 4
  plataformas hayan sincronizado bien.
- `tests/casino-connectors/dateHelpers.test.js` — `buildApiDateRange` con
  fechas planas (comportamiento idéntico a antes) y timestamps exactos
  (incluyendo cruce de medianoche UTC↔ART).
- `tests/casino-connectors/ArgenBetConnector.test.js` — ampliado: adapter
  recibe `{loginUrl, credentials}` desde las env vars correctas, sanitización
  del rechazo del adaptador, validación estricta de `id`/`amount`.
- Frontend (vitest): `casino-sync-status-route.test.ts`,
  `cron-casino-sync-route.test.ts`, `test-casino-sync-route.test.ts` (nuevos)
  — status/permisos, unauth del cron, propagación de fallo parcial (207,
  nunca 200), nunca `ok:true` en timeout/spawn-error/exit≠0.

`npm test` (raíz): verde. Frontend: los 3 archivos de test nuevos de fase 4
en verde vía `npx vitest run <archivo>` (no se corrió la suite completa de
frontend en esta sesión — hay archivos preexistentes dirty de otra sesión
que este trabajo no toca ni depende de que estén en verde).

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

### Cierre de integración

- El botón manual registra fallos de configuración y de arranque en
  `casino_sync_runs`. Los rechazos de permisos o entradas inválidas no
  crean corridas. Una solicitud aceptada devuelve HTTP 202 y remite al
  estado de sincronización; no promete un éxito anticipado.
- Zeus/Bet30 ahora leen el cliente OAuth de `*_LOGIN_CLIENT_ID` y
  `*_LOGIN_CLIENT_SECRET` en el entorno, además de `*_ADMIN_USER` y
  `*_ADMIN_PASSWORD`. Se retiraron los valores embebidos de la configuración.
  El auto-login exige configurar esas variables nuevas. Sus errores no
  incluyen URLs ni cuerpos de respuesta con credenciales.
- Verificación final: `npm test -- --runInBand` (312 aprobadas, 1 omitida),
  `npx vitest run` en frontend (856 aprobadas, 6 omitidas),
  `npx tsc --noEmit --incremental false` (correcto). Las pruebas omitidas
  dependen de integración con una base; no se ejecutaron migraciones reales.
- El importador Excel y la migración 126 no se modificaron. Los cambios
  previos ajenos del usuario quedaron fuera de los cuatro commits.
