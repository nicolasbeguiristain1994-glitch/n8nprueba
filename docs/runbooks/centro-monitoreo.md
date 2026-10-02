# Runbook — Centro de Monitoreo (etapa 1: sync de casino)

> **Solo instrucciones.** Nada de este documento se ejecuta automáticamente. Aplicar la
> migración, clasificar datos históricos o activar corridas en un entorno real requiere
> aprobación explícita y se hace a mano, con el sync detenido.

---

## 1. Alcance

**Entra en esta etapa**

| Problema | Solución |
|---|---|
| `casino_players` se inflaba en cada re-sync (`total + EXCLUDED`) | Ingesta y recompute en **una** transacción; el recompute **asigna** desde `casino_transactions` |
| Un rollback dejaba jugadores sumados sin transacciones | `persistSync` hace todo o nada; locks por jugador para corridas concurrentes |
| `casino_transactions` sin plataforma; ID único global | Columna `platform`, dedup `(platform, id_rec)`; histórico `NULL` sin atribuir |
| Cursor `MAX(fecha) + 1 day` global (Bet30 dependía de Zeus, se perdía el resto del día) | Cursor por plataforma y agente: último tramo **contiguo** de días cerrados (UTC−3) |
| Fallos silenciosos (exit 0 con todos los agentes caídos) | Runner con estados honestos y exit ≠ 0; segmentación solo tras éxito |
| Sin registro de corridas | `casino_sync_runs`, `casino_sync_agent_ranges`, `casino_sync_cursors` + heartbeat |
| `spawn('sh', ['-c', …])` con parámetros del usuario | `spawn(node, argv)` + validación de fechas/agentes/plataforma |
| Sin visibilidad | `GET /api/monitoring/casino-sync` + pantalla `/monitoreo` (solo admin) con alertas internas |

**No entra (pendiente, explícito)**

- **D2** — `casino_players` sigue siendo único por `LOWER(username)`: un jugador con el
  mismo username en Zeus y Bet30 es **una** fila con la suma de ambas plataformas
  (misma semántica que antes). Cambiar la clave exige auditar consumidores
  (`/api/contacts/[id]/casino-stats`, `/api/lists/casino`, `segmentar-casino-players.js`,
  `116_player_ltv.sql`, dashboard). Ver `docs/PLAN-METRICAS-4-PLATAFORMAS.md` §D2.
- Conectores de Ganamos y Argenbet (el endpoint de sync los rechaza con 400).
- Cambios en n8n (WF-030), en la cadencia o activación de automatizaciones.
- Mensajes o alertas externas (Slack, email, WhatsApp): las alertas son internas
  (pantalla + logs con `alert: true`).
- Montos con centavos (H6) y re-auth ante 401 a mitad de corrida (H11).

---

## 2. Componentes

| Pieza | Archivo |
|---|---|
| Migración (revisable) | `db/migrations/125_casino_sync_monitoring.sql` |
| Preflight de solo lectura | `db/manual/125_preflight_readonly.sql` |
| Backfill manual de agentes inequívocos | `db/manual/125_backfill_platform_inequivocos.sql` |
| Reparación histórica de agregados (dry-run) | `db/manual/125_repair_casino_players_aggregates.sql` |
| Ingesta + recompute | `src/casino-connectors/base/BaseCasinoConnector.js` |
| Runner (lock, cursor, registro) | `src/casino-connectors/sync/runner.js`, `SyncRunStore.js`, `cursor.js`, `dates.js`, `sanitize.js`, `cli-args.js`, `agents.js` |
| CLI | `scripts/sync-casino-players-live.js` |
| Cadena sync → segmentación (sin shell) | `scripts/casino-sync-and-segment.js` |
| Pipeline diario | `scripts/pipeline-diario.js` (ya no trata fallos de sync como "continuar") |
| API disparo | `POST /api/dashboard/casino/sync` |
| API monitoreo | `GET /api/monitoring/casino-sync` |
| Pantalla | `/monitoreo` (sidebar → Monitoreo, solo admin) |

### Semántica

- **Estados de corrida:** `running`, `success`, `partial` (algún agente falló), `failed`,
  `skipped` (otra corrida de la plataforma tenía el lock). Una corrida `running` sin
  heartbeat hace más de 10 min se muestra como **Interrumpida** y la próxima corrida de
  esa plataforma la cierra como `failed / INTERRUPTED`.
- **Códigos de salida de la CLI:** `0` éxito · `1` fallo o parcial (incluye fallos de
  auth, de un agente y de persistencia) · `2` argumentos inválidos · `3` omitida por lock.
  Cualquier valor ≠ 0 corta la segmentación.
- **Concurrencia dentro de una corrida:** el runner espera a que terminen **todos** los
  agentes antes de cerrar la corrida y liberar el lock. Si se pierde la persistencia del
  registro (no se puede guardar el resultado de un tramo), ningún agente inicia tramos
  nuevos, los que están en curso terminan, y la corrida cierra `failed /
  PERSISTENCE_FAILED`.
- **Reuso de `run_id`:** la API pre-registra la corrida con `instance_id = NULL`. El runner
  solo adopta (o cierra como `skipped`) una fila así y con exactamente los mismos
  parámetros. Un `run_id` de una corrida activa, terminada o de otro runner se rechaza con
  `RUN_ID_REUSED` sin modificar la fila original.
- **Rango procesado** (`casino_sync_cursors`): `[covered_from, covered_through]` = días
  cerrados (hora Argentina) sincronizados con éxito **sin huecos**. Indica lo que se pidió
  y guardó; no prueba que el proveedor no tenga movimientos faltantes. Un rango exitoso
  contiguo o solapado lo extiende; uno disjunto no lo mueve; un fallo no lo toca; el día
  en curso nunca cuenta.
- **Modo `--auto`:** por agente, desde `covered_through` (solapamiento de 1 día,
  `--overlap-days`) hasta hoy. Agente sin cursor → `CURSOR_MISSING` (falla, no adivina)
  salvo `--bootstrap-desde=YYYY-MM-DD`.
- **Tramo fallido:** los tramos siguientes del mismo agente quedan `skipped /
  PREVIOUS_CHUNK_FAILED` (no se saltan huecos).
- **Certeza** (`coverage` en DB: `complete` / `limited`; en pantalla: "sin limitaciones
  detectadas" / "certeza limitada"). `limited` = hubo movimientos sin ID (`id_rec` nulo,
  `0`, negativo o no numérico) deduplicados por
  `(plataforma, fecha, LOWER(username), tipo, monto, agente)` —si dos eventos reales
  coinciden en esa clave, uno se pierde (`tx_collapsed_without_id`)— o filas que el
  conector no pudo interpretar (`tx_invalid`: sin usuario/fecha, tipo desconocido, monto
  no numérico). Las exclusiones esperadas (movimientos "indirecto" entre agentes) se
  cuentan aparte (`tx_excluded`) y no limitan la certeza.
- **Respuestas inválidas:** un HTTP 200 con un cuerpo que no es un array ni un envelope
  conocido con array (`{error: …}`, `{message: …}`, no-JSON) falla con `INVALID_RESPONSE`
  y **no** avanza el cursor. Un `[]` válido sí avanza.
- **Rango observado ≠ rango procesado:** la pantalla muestra por separado el rango
  procesado por el cursor y los movimientos presentes en la base. La ausencia de
  movimientos no es alerta.
- **Resultado efectivo vs. último intento:** una corrida (o tramo) omitido no oculta el
  último fallo ni sus alertas; se muestra aparte como "último intento omitido".
- **Agentes configurados** (`src/casino-connectors/sync/agents.js`, copia verificada por
  test en `frontend/lib/monitoring/casino-sync.ts`) aparecen aunque nunca hayan corrido,
  con la alerta `never_synced`.
- **Errores en DB y logs:** de errores externos (API, login, red, Postgres) se guarda
  **solo** un código y un mensaje genérico de una lista cerrada (más el status HTTP
  numérico). Su texto nunca se persiste ni se loguea, porque puede contener secretos que
  ninguna regex detecta con garantía. Solo los errores de dominio (`SyncError`, con
  valores controlados: agente, fechas, conteos) conservan su mensaje.

### Códigos de error frecuentes

| Código | Significado | Acción |
|---|---|---|
| `AUTH` | Login del casino o token rechazado | Revisar credenciales en el entorno (sin exponerlas) |
| `UPSTREAM` / `TIMEOUT` / `NETWORK` | API del casino caída o lenta | Reintentar luego; el cursor no avanzó |
| `LEGACY_UNCLASSIFIED` | Filas históricas sin plataforma en el rango del agente, o con el mismo `id_rec` que movimientos nuevos (aunque sean de otro agente) | §4 |
| `CURSOR_MISSING` | Agente sin cursor en modo auto | §5 (bootstrap) |
| `INVALID_RESPONSE` | La API respondió 200 con un formato desconocido o no-JSON | Revisar la API; el cursor no avanzó |
| `PERSISTENCE_FAILED` | No se pudo guardar el resultado de un tramo; la corrida se detuvo | Revisar la base; relanzar |
| `RUN_ID_REUSED` | El `run_id` ya pertenecía a otra corrida | Nada que reparar: la corrida original quedó intacta |
| `LOCK_BUSY` | Otra corrida de la plataforma en curso | Esperar; no es un fallo de datos |
| `INTERRUPTED` | Proceso muerto o señal de parada | Relanzar; revisar logs del proceso |
| `SPAWN_FAILED` / `CHILD_EXIT` | La API no pudo lanzar el proceso o murió al arrancar | Revisar entorno del servidor |
| `DB_xxxxx` | Error de Postgres (SQLSTATE) | Revisar logs; `DB_42P01` = migración 125 pendiente |

---

## 3. Prerrequisitos

1. **Base correcta.** Verificar que la conexión apunta a la base de la app (no a la del
   proyecto bot-whatsapp).
2. **Conexión del runner.** `DATABASE_URL` del proceso de sync debe ser **conexión directa
   o pooler en modo sesión**: el lock por plataforma es `pg_try_advisory_lock` de sesión y
   un pooler transaccional no lo sostiene.
3. **Sync detenido** durante la migración (`CREATE UNIQUE INDEX` bloquea escrituras en
   `casino_transactions`). Pausar el disparo del pipeline diario / WF-030 según el
   procedimiento operativo habitual.
4. **Scripts legacy.** Después de la 125, `scripts/seed-casino-transactions.js` falla a
   propósito (su `ON CONFLICT (id_rec) WHERE id_rec IS NOT NULL` ya no tiene índice
   que coincida): insertaría filas sin plataforma. `scripts/rebuild-casino-players-from-db.js`
   sigue funcionando pero con semántica distinta al recompute (normaliza `agente` a nombres
   de Zeus y filtra agentes): **no mezclarlo con el runner** sin revisar.

### 3.1 Pausa operativa `CASINO_SYNC_PAUSED`

Variable de entorno del servicio. **`1` pausa, `0` no pausa.** Sin definir, vacía, `0` o
`false` (sin distinguir mayúsculas) mantienen el comportamiento normal; **cualquier otro
valor no vacío pausa** (una configuración desconocida falla cerrada).

**Qué bloquea** (inicios nuevos, después de la autenticación y los permisos originales):

| Disparador | Con pausa |
|---|---|
| Runner (`runSync`: CLI, cadena sync → segmentación, `pipeline-diario.js`) | Termina con exit `1` y `CASINO_SYNC_PAUSED` **antes** de tomar el lock, consultar la base o autenticarse con el proveedor. No registra corrida; la cadena no segmenta. |
| `POST /api/dashboard/casino/sync` | `503` `CASINO_SYNC_PAUSED`, sin consultas de casino ni procesos |
| `GET /api/admin/test-casino-sync` | `503`, sin diagnósticos ni sync en foreground |
| `POST /api/admin/resegment` | `503`, sin lanzar la segmentación |
| `POST /api/admin/migrate` | `503`, sin ejecutar pasos (recalculan `casino_players` y derivados) |

**Qué no hace:**
- No afecta lecturas: `/monitoreo`, el dashboard y `GET /api/monitoring/casino-sync`
  siguen funcionando.
- **No cancela corridas ni procesos que ya estaban en curso.** Antes de la 125 hay que
  confirmar que terminaron los contenedores/instancias con el código **anterior** y sus
  procesos hijos de sync (en particular el job autónomo del sync viejo de Bet30).
- **No detiene procesos que no leen esta variable**: el código anterior (desplegado
  antes de esta release) la ignora. El job autónomo viejo tiene que seguir pausado por su
  propio mecanismo, además de la variable, hasta la aprobación de activación.

**Rollout (solo con aprobación):**
1. Definir `CASINO_SYNC_PAUSED=1` en **todos** los servicios/paneles que usan esta base
   (producción y staging la comparten) y desplegar esta release con la variable ya puesta.
2. Confirmar la terminación de las instancias viejas y sus hijos, y que el job autónomo
   viejo sigue pausado.
3. Recién entonces aplicar la 125 (§4.2).
4. Mantener `CASINO_SYNC_PAUSED=1` después de la migración, hasta que se aprueben el
   histórico (§4.3) y el bootstrap/activación (§5).

---

## 4. Preflight, migración y datos legacy

### 4.1 Preflight (solo lectura)

```bash
psql "$URL_APROBADA" -v ON_ERROR_STOP=1 -f db/manual/125_preflight_readonly.sql > preflight-125.txt
```

Revisar en la salida:

- §1 índices actuales (`idx_casino_transactions_id_rec`, `idx_casino_transactions_dedup`).
- §3 clasificación por agente: `ZEUS_ONLY`, `BET30_ONLY`, `AMBIGUO` (bigwin), `SIN_MAPEO`.
- §4 `id_rec` en 0/negativos.
- §6 colisiones contra la plataforma destino, con ID y sin ID (incluidas filas ya
  clasificadas): deben estar vacías o resueltas antes del backfill.
- §7 deriva actual de `casino_players` (magnitud de la inflación existente).
- §9 puerto/servidor (confirmar conexión directa o sesión).

### 4.2 Migración

```bash
psql "$URL_APROBADA" -v ON_ERROR_STOP=1 -f db/migrations/125_casino_sync_monitoring.sql
```

Verificación posterior (solo lectura):

```sql
SELECT indexname FROM pg_indexes WHERE tablename = 'casino_transactions' ORDER BY 1;
SELECT relname, relrowsecurity FROM pg_class WHERE relname LIKE 'casino\_sync\_%' AND relkind = 'r';
SELECT COUNT(*) FILTER (WHERE platform IS NULL) AS sin_plataforma FROM casino_transactions;
```

### 4.3 Clasificación del histórico (manual)

- **Agentes inequívocos** (Zeus: betcoin, ofizeus, royal, farabet, lasvegas · Bet30:
  btcuno, btcdos, zeus, zeusroyal): revisar y correr
  `db/manual/125_backfill_platform_inequivocos.sql`. El archivo termina en `ROLLBACK`;
  cambiarlo por `COMMIT` solo si los conteos coinciden con el preflight aprobado.
- **Cómo bloquean las filas `NULL`** (dos controles independientes, ambos fail-closed):
  1. *Por agente y rango* (`SyncRunStore.countUnclassifiedLegacy`, desde `runner.js`): un
     tramo falla con `LEGACY_UNCLASSIFIED` si hay filas `NULL` **del mismo agente**
     (sin distinguir mayúsculas) dentro de ese rango de fechas.
  2. *Por ID* (`BaseCasinoConnector._assertNoLegacyIdCollision`): un tramo falla si
     cualquier movimiento traído tiene un `id_rec` igual al de **cualquier** fila `NULL`,
     sin importar agente, fecha ni plataforma.
- **bigwin** (Zeus y Bet30): **no se atribuye automáticamente** y este runbook no define
  criterio. Mientras tenga filas `NULL`, el control 1 bloquea `zeus/bigwin` y
  `bet30/bigwin` en los rangos que las contienen. Sincronizar solo rangos posteriores a su
  última fila legacy evita el control 1 pero **no garantiza desbloqueo**: el control 2
  sigue fallando si algún movimiento nuevo comparte `id_rec` con una fila `NULL`. La única
  salida definitiva es clasificarlas con un criterio documentado y aprobado.
- **SIN_MAPEO**: revisar a mano. No activan el control 1 de otros agentes (es por nombre de
  agente), pero **sí participan del control 2**: pueden bloquear a cualquier agente o
  plataforma cuyos movimientos compartan un `id_rec` con ellas.
- Referencia de solo lectura para dimensionar lo que queda sin clasificar:

  ```sql
  SELECT LOWER(agente) AS agente,
         COUNT(*)                                AS filas_null,
         COUNT(*) FILTER (WHERE id_rec IS NOT NULL) AS con_id,
         MIN(id_rec) AS id_min, MAX(id_rec) AS id_max,
         MIN(fecha)  AS desde,  MAX(fecha)  AS hasta
  FROM casino_transactions
  WHERE platform IS NULL
  GROUP BY LOWER(agente)
  ORDER BY filas_null DESC;
  ```

---

## 5. Activación manual aprobada

1. **Tests locales en verde** (§6).
2. **Deploy del código** por el proceso habitual (fuera de este runbook).
3. **Bootstrap de cursores**, por plataforma, con un rango manual acotado y aprobado
   (establece el cursor sin adivinar). Con `CASINO_SYNC_PAUSED=1` (§3.1) el runner no
   arranca: solo con la aprobación de activación, el proceso de esa corrida manual se
   ejecuta con `CASINO_SYNC_PAUSED=0` explícito, mientras el servicio y los disparadores
   periódicos siguen en `1`. Ejemplo, desde una terminal con el entorno del servidor:

   ```bash
   node scripts/sync-casino-players-live.js --platform=zeus  --desde=AAAA-MM-DD --chunk-days=7
   node scripts/sync-casino-players-live.js --platform=bet30 --desde=AAAA-MM-DD --chunk-days=7
   ```

   Alternativa: `--auto --bootstrap-desde=AAAA-MM-DD` (solo afecta a agentes sin cursor).
4. Verificar en `/monitoreo`: corridas `success`, cursores hasta ayer, sin
   `classification_required` ni `cursor_missing` inesperados.
5. **Recién entonces**, con aprobación de activación, pasar `CASINO_SYNC_PAUSED` a `0` en
   los servicios y reanudar el disparo diario existente (sin cambiar su cadencia).
   Desde este cambio, `pipeline-diario.js` sale con código 1 y no segmenta si algún sync
   no terminó con éxito (incluida la pausa).

**Jugadores ya inflados:** el recompute corrige a cada jugador solo cuando un sync lo
toca; un jugador inactivo inflado por el bug anterior no vuelve a aparecer. Para ellos:
`db/manual/125_repair_casino_players_aggregates.sql` recalcula desde
`casino_transactions` a todos los jugadores existentes con la misma semántica del
recompute, **sin** insertar ni borrar jugadores y **sin** tocar segmentos. Termina en
`ROLLBACK` (dry-run) e incluye verificaciones (diferencias restantes, delta de jugadores,
segmentos, jugadores sin fuente). Pasar a `COMMIT` solo con aprobación, con el sync
detenido, y después recalcular la segmentación por el procedimiento habitual. La
alineación de `agente`/`platform` está como bloque opcional comentado. Medir
antes/después con el preflight §7.

**WF-030 (n8n):** no se modificó. Sigue marcando verde cuando la API responde `ok`, que
ahora significa "corrida iniciada" (HTTP 202 con `run_id`), no "sync exitoso". El estado
real está en `/monitoreo`.

---

## 6. Tests

```bash
# Unit (Jest, raíz): conector, runner, cursor, sanitización, argumentos
npm test

# Integración con Postgres LOCAL (opcional). Nunca usa DATABASE_URL.
# Crea y borra un schema temporal; se niega a correr contra hosts no locales
# (considera ?host=/?hostaddr= y PGHOST; ver tests/helpers/local-db-guard.js).
TEST_DATABASE_URL=postgresql://localhost:5432/wa_test ./node_modules/.bin/jest tests/casino-connectors/sync-integration.pg.test.js tests/casino-connectors/sync-migration.pg.test.js tests/casino-connectors/sync-manual-sql.pg.test.js --runInBand --modulePathIgnorePatterns=frontend/.next

# Frontend (Vitest) y tipos. Cada comando corre en un subshell desde la raíz del
# repo, así el directorio actual no cambia entre comandos.
( cd frontend && npx vitest run \
    lib/__tests__/casino-sync-route.test.ts \
    lib/__tests__/monitoring-casino-sync-route.test.ts \
    lib/__tests__/casino-sync-monitoring-lib.test.ts \
    lib/__tests__/casino-maintenance-routes.test.ts )
( cd frontend && npx tsc --noEmit )
```

La integración cubre: mismo rango 10 veces, rollback, mismo ID en dos plataformas,
usuarios con mayúsculas mixtas, histórico de otros agentes, `id_rec = 0`, fail-closed
legacy, cursor (bootstrap / vacío / fallo / disjunto), lock por plataforma, reuso de
`run_id` (activo y terminado), corridas interrumpidas, recompute concurrente del mismo
jugador y RLS.

---

## 7. Rollback

**Antes de decidir:** volver al código anterior reintroduce el bug de agregados
(`upsertPlayers` suma `total + EXCLUDED` en cada re-sync), el cursor global por día y las
fallas silenciosas. Restaurar los índices solo hace que su `ON CONFLICT` vuelva a
funcionar; **no hace seguro reanudar el sync**. Con el código anterior el sync queda
**detenido** hasta que haya una solución aprobada. Además, las filas que ese código
insertara quedarían sin plataforma y bloquearían (fail-closed) una vuelta posterior a
este código hasta clasificarlas.

**Orden obligatorio:** detener el sync → ensayo con `ROLLBACK` → revisión y aprobación →
ejecución aprobada → verificación de índices → recién entonces revertir el código. **No
revertir el código antes** de que la restauración de índices aprobada haya terminado con
éxito.

1. **Sync detenido.** Pausar el pipeline diario / WF-030 y no disparar
   `POST /api/dashboard/casino/sync`. Revisar (solo lectura) corridas y locks de esta base:

   ```sql
   SELECT run_id, platform, heartbeat_at FROM casino_sync_runs WHERE status = 'running';
   -- Lock de plataforma del runner: pg_try_advisory_lock(7125, hashtext('casino_sync:<platform>'))
   SELECT pid, granted FROM pg_locks
   WHERE locktype = 'advisory' AND classid = 7125 AND objsubid = 2
     AND database = (SELECT oid FROM pg_database WHERE datname = current_database());
   ```

   La consulta de locks debe devolver 0 filas. Una fila `running` puede pertenecer a un
   proceso interrumpido: comprobar su heartbeat y la terminación del proceso en el
   servidor, sin editar su estado para pasar este control. La ausencia de filas o locks
   por sí sola no prueba que los disparadores estén pausados; confirmar también la
   pausa operativa antes de continuar.

2. **Ensayo (termina en `ROLLBACK`).** Guardar este bloque como archivo del ticket y
   correrlo con `psql "$URL_APROBADA" -v ON_ERROR_STOP=1 -f <archivo>.sql`. Los límites son
   **ejemplos**: ajustarlos antes de producción según el tamaño de la tabla (preflight §2)
   y la ventana acordada.

   ```sql
   BEGIN;
   SET LOCAL lock_timeout      = '5s';     -- ejemplo: espera máxima por locks
   SET LOCAL statement_timeout = '15min';  -- ejemplo: tope por sentencia (CREATE INDEX)

   -- Bloquea INSERT/UPDATE/DELETE (no lecturas) desde la comprobación hasta el DDL.
   LOCK TABLE casino_transactions IN SHARE ROW EXCLUSIVE MODE;

   -- Colisiones que los índices globales anteriores rechazarían. Solo se listan:
   -- no se borra ni se deduplica nada.
   SELECT id_rec, array_agg(platform) AS plataformas, COUNT(*) AS filas
   FROM casino_transactions
   WHERE id_rec IS NOT NULL
   GROUP BY id_rec HAVING COUNT(*) > 1
   ORDER BY filas DESC LIMIT 50;

   SELECT fecha, username, tipo, monto, agente, array_agg(platform) AS plataformas, COUNT(*) AS filas
   FROM casino_transactions
   WHERE id_rec IS NULL
   GROUP BY fecha, username, tipo, monto, agente HAVING COUNT(*) > 1
   ORDER BY filas DESC LIMIT 50;

   -- Aborto verificable: con cualquier colisión, la transacción falla acá y no se
   -- ejecuta ningún DDL.
   DO $$
   DECLARE
     n_id     bigint;
     n_sin_id bigint;
   BEGIN
     SELECT COUNT(*) INTO n_id FROM (
       SELECT 1 FROM casino_transactions WHERE id_rec IS NOT NULL
       GROUP BY id_rec HAVING COUNT(*) > 1) x;
     SELECT COUNT(*) INTO n_sin_id FROM (
       SELECT 1 FROM casino_transactions WHERE id_rec IS NULL
       GROUP BY fecha, username, tipo, monto, agente HAVING COUNT(*) > 1) y;
     IF n_id > 0 OR n_sin_id > 0 THEN
       RAISE EXCEPTION 'Restauración de índices abortada: % id_rec repetidos, % claves sin ID repetidas',
         n_id, n_sin_id;
     END IF;
   END $$;

   CREATE UNIQUE INDEX idx_casino_transactions_id_rec
     ON casino_transactions (id_rec) WHERE id_rec IS NOT NULL;
   CREATE UNIQUE INDEX idx_casino_transactions_dedup
     ON casino_transactions (fecha, username, tipo, monto, agente) WHERE id_rec IS NULL;

   DROP INDEX IF EXISTS idx_casino_transactions_platform_id_rec;
   DROP INDEX IF EXISTS idx_casino_transactions_legacy_id_rec;
   DROP INDEX IF EXISTS idx_casino_transactions_platform_dedup;
   DROP INDEX IF EXISTS idx_casino_transactions_legacy_dedup;

   SELECT indexname, indexdef FROM pg_indexes
   WHERE tablename = 'casino_transactions'
     AND schemaname = (SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE c.oid = 'casino_transactions'::regclass)
   ORDER BY indexname;

   ROLLBACK;  -- por defecto. COMMIT solo en el paso 3.
   ```

   **Si aborta** (colisión, `lock_timeout` o `statement_timeout`): `psql` sale con error y
   la transacción se descarta. Confirmarlo con la consulta de `pg_indexes` del final (fuera
   de la transacción): los índices tienen que seguir siendo los de la 125. Con colisiones,
   **no** hay restauración posible sin una decisión manual sobre esos datos, que queda
   fuera de este runbook; el código actual sigue siendo el único compatible.

3. **Ejecución aprobada.** Solo con la salida del ensayo revisada y aprobación explícita,
   en la misma ventana y con el sync todavía detenido: correr el mismo bloque cambiando
   únicamente el `ROLLBACK;` final por `COMMIT;`.

4. **Verificación.** La consulta de `pg_indexes` debe mostrar
   `idx_casino_transactions_id_rec` e `idx_casino_transactions_dedup`, sin los cuatro
   índices `platform_*` / `legacy_*`.

5. **Recién entonces** revertir el código por el proceso habitual. El sync sigue
   **detenido** (ver "Antes de decidir").

**Qué se conserva:** la columna `platform` y las tablas `casino_sync_runs`,
`casino_sync_agent_ranges` y `casino_sync_cursors` quedan tal cual. El código anterior las
ignora, y borrarlas eliminaría el historial de corridas, cursores y clasificación sin
ningún beneficio para el rollback. Los índices no únicos de la 125
(`idx_casino_transactions_username_lower`, `idx_casino_transactions_platform_agente_fecha`,
`idx_casino_transactions_unclassified`) tampoco molestan al código anterior y se mantienen.

**Datos:** el recompute solo reescribe totales y `agente`/`platform` de jugadores tocados;
no borra filas ni toca segmentación. Revertir código no revierte totales corregidos (y no
debería: los anteriores estaban inflados).


### Evidencia local de scripts manuales (2026-09-13)

La [validación final](centro-monitoreo-validacion.md) incluye ejecución real de los scripts manuales en esquemas temporales con datos simulados, inspección de sus efectos y restauración exacta tras `ROLLBACK`. Los reportes de reparación cubren importes, cantidades, fechas, metadatos y filas sin fuente. El preflight toma el esquema efectivo y comprueba colisiones contra la plataforma destino, incluso contra filas ya clasificadas.

Antes de producción siguen siendo necesarias la revisión de candidatos reales, una ventana con el sync detenido, límites de espera acordados y la aprobación explícita. No habilitar el bloque opcional de alineación de agente/plataforma ni convertir `ROLLBACK` a `COMMIT` sin esa revisión.
