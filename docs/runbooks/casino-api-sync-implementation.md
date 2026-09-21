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

## Verificación (esta sesión, después de todos los cambios)

- Raíz: `npm test -- --runInBand` → 96 aprobados, 1 omitido (6/7 suites, 1 skip).
- Frontend: `npx vitest run` → 822 aprobados, 6 omitidos (43/44 archivos, 1 skip).
- Frontend: `npx tsc --noEmit --incremental false` → sin errores.

Estos resultados verifican comportamiento contra mocks/fixtures, no contra
una base Postgres real — la migración 127 no fue aplicada ni validada contra
una base real en ninguna sesión. El dueño de la base debe correrla y revisar
los `RAISE NOTICE` (jugadores/transacciones ambiguos) antes de desplegar el
`BaseCasinoConnector` actualizado.

No se ejecutaron migraciones, sync reales, ni llamadas de red en ninguna
sesión. No se tocó el importador de Excel ni las migraciones existentes
(116/123/126). No se tocó `AGENTS.md`/`CLAUDE.md`.

## Fases 2-4

**No iniciadas.** Siguen pendientes `ArgenBetConnector`, `GanamosConnector`,
el sync incremental con lock, registro `casino_sync_runs`, pipeline y
programación n8n. Argenbet/Ganamos no deben presentarse como sincronización
funcional por tener ya listas o validación de credenciales en frontend.

Faltan capturas sanitizadas del login de Argenbet y Ganamos: URL, método,
headers necesarios sin secretos, forma del body, respuesta token/cookies,
expiración y renovación; para Ganamos, CSRF si corresponde y cookies
necesarias por agente. No inventar endpoints. Argenbet requiere fallback
`ARGENBET_PLAYER_TOKEN` temporal (ya documentado en `.env.example`).

Especificación de fase 3/4 (resumen, ver prompt original para el detalle
completo): Argenbet — endpoint `/player`, `offset`/`limit=50`, IDs
confirmados, rol `player` `INCOME`/`OUTCOME`; identidad idéntica a
`src/casino-import/excel.js` (recordId SHA-256, UUID negativo, `source_id`
string); token estático y `loginUrl` configurable, aislado, sin inventar
protocolo. Ganamos — 6 sesiones independientes por agente, cookie jars, días
en UTC sin zona, ventana de 24h, paginación de 500, warning a los 7 días.
Fase 4 — `MAX(timestamp)` por plataforma con -30min de margen (Ganamos día
completo), advisory lock retenido en la misma conexión durante toda la
corrida, registro en `casino_sync_runs` por agente incluso en fallos de
auth/config, exit code no-cero ante cualquier fallo parcial, un solo
schedule n8n de 15min (no prometer 5min).

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

Al retomar fase 2: confirmar estado de Git, leer este documento completo
(no solo el resumen), y empezar por los conectores de Argenbet/Ganamos según
la especificación de arriba — sin login capturado para ninguna de las dos,
el trabajo de fase 2/3 es necesariamente parcial (adaptador configurable con
TODO explícito, no un flujo de auth "validado").
