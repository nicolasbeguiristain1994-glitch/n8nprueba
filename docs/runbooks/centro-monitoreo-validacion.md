# Centro de Monitoreo — entrega local y validación

Fecha: 2026-09-13. Coordinación: Codex + Claude Code CLI.

## Ubicación y aislamiento

- Original: `/Users/nicobegui/Desktop/whatsapp-automation-platform`, rama `main`, base `8a218b8`.
- Copia de trabajo: `/private/tmp/wa-monitoring-20260913`; snapshot de los cambios locales: `4fbd1ca5c38d87e0cfedef15f1aae16ab7924ba4`.
- Rama de entrega: `feature/centro-monitoreo`, con commits propios sobre la base original que contienen solamente esta entrega. La copia de trabajo también conserva los archivos locales preexistentes; no se mezclan en el commit de entrega.
- Sesión dedicada de Claude: `6de03412-8bd7-493c-a429-7e8d537cc281`. Confianza del proyecto comprobada en `hasTrustDialogAccepted=true`; autenticación y comunicación directa confirmadas. Se retomó esa sesión, sin asumir la conversación de la extensión.
- Claude implementó y corrigió con herramientas de lectura y escritura limitadas a la copia aislada, sin herramientas de shell. Codex revisó y ejecutó las pruebas. No se modificaron permisos de Claude ni se usó bypass.
- Los 37 archivos locales preexistentes conservan su SHA-256 tanto en el original como en la copia. El original sigue en `main` y sus cambios locales están preservados.

## Implementado

- Ingesta y recompute de jugadores en una transacción; asignación desde `casino_transactions`, bloqueos por jugador y deduplicación de transacciones por plataforma/ID.
- Cursor independiente por plataforma/agente, días cerrados de Argentina, solapamiento, vacío válido y continuidad de rangos. Un fallo o una respuesta desconocida no se convierten en éxito silencioso.
- Registro de corridas y resultados por agente/rango, heartbeat, bloqueo por plataforma, estado parcial/fallido y salida no-cero. Las tareas concurrentes terminan antes de liberar el bloqueo.
- POST de sync con admin fresco, validación, argv sin shell y `run_id`; segmentación solamente después de sync exitoso y de registrar su inicio.
- GET de monitoreo y pantalla `/monitoreo`, cobertura procesada/observada, agentes nunca sincronizados, alertas internas de fallas, históricos sin clasificar, retrasos e interrupciones. Los intentos omitidos no reemplazan el último resultado efectivo.
- Errores externos descritos mediante códigos y mensajes controlados, sin persistir cuerpos de login ni mensajes externos libres.
- SQL separado para preflight, clasificación inequívoca y reparación de agregados históricos. Los dos scripts de modificación terminan en `ROLLBACK`.

Esta etapa usa los conectores existentes de Zeus y Bet30. La identidad global de `casino_players` se conserva para no cambiar sus consumidores: la separación de jugadores por plataforma (D2) sigue pendiente. No se agregaron conectores de Ganamos/Argenbet, no se cambió la cadencia ni se activaron automatizaciones. n8n sigue confirmando la aceptación del pedido; el resultado real se consulta por corrida en Monitoreo.

## Validaciones ejecutadas

| Control | Resultado |
|---|---|
| Jest, backend y scripts (corrida completa final) | 287 aprobadas, 12 suites, sin omisiones |
| PostgreSQL real, incluido en Jest | 35 casos: sync (18), migración/preflight/RLS (10), SQL manual (7); socket local y datos simulados |
| Vitest, rutas, alertas, página, nonce CSP y cloud-api | 97 aprobadas, 6 archivos |
| Encadenamiento sync → segmentación | 6 aprobadas, incluidas en Jest; procesos y DB simulados |
| Build Next.js final | Aprobado, incluye `/monitoreo` y sus endpoints |
| TypeScript separado | Aprobado sin errores; corregidos los cinco TS1308 del archivo de tests cloud-api y aislados sus mocks |
| Reproducciones de revisión | Corregidas liberación prematura de lock y filtración de mensaje externo, usando fixtures sin DB |
| Playwright headless, dev server Turbopack | Aprobado: 18 capturas a 1440×1100, 390×844 y 320×740; sin desborde de página o alertas |
| Cambios locales originales | 37 hashes preservados nuevamente; sin cambios sobre `main` |

Comandos ejecutados desde la copia:

```sh
./node_modules/.bin/jest --runInBand --modulePathIgnorePatterns=frontend/.next
cd frontend
./node_modules/.bin/vitest run --maxWorkers=1 --no-file-parallelism lib/__tests__/casino-sync-route.test.ts lib/__tests__/monitoring-casino-sync-route.test.ts lib/__tests__/casino-sync-monitoring-lib.test.ts lib/__tests__/monitoreo-page.test.tsx lib/__tests__/csp-nonce.test.tsx lib/__tests__/cloud-api.test.ts
./node_modules/.bin/tsc --noEmit --incremental false
npm run build
```

### PostgreSQL: alcance exacto de la evidencia

Se creó un PostgreSQL temporal, únicamente por socket local, sin listener TCP ni datos de producción. La reproducción del código original dio 1.000 en agregados frente a 100 en transacciones después de diez repeticiones.

Sobre la primera versión se aprobaron diez controles independientes con PostgreSQL real: preflight de solo lectura, migración aplicada dos veces, diez repeticiones conservando 100=100, mismo ID entre plataformas, mayúsculas de usuario, metadatos preservados, rollback, concurrencia, bloqueo de históricos sin clasificar, cursores vacíos/disjuntos e independencia, y RLS (algunos se agruparon en un mismo caso).

**Los diez controles iniciales corresponden a la primera versión.** La ronda de revisión agregó `tx_invalid`/`tx_excluded`, ajustó índices y agregó el SQL de reparación.

**La suite adicional de la versión final ya fue autorizada explícitamente y ejecutada: 18/18 pruebas aprobadas.** Aplicó las migraciones 025, 028, 031, 123 y 125 en un esquema temporal de la base `monitoring_test`, con el usuario local `monitoring_local`. Antes de ejecutar se comprobó: directorio `/private/tmp/wa-monitoring-pgdata`, conexión por `/private/tmp/wa-monitoring-pg-socket`, `listen_addresses` vacío, `inet_server_addr()` nulo y permisos de socket `0700`. El proceso recibió un entorno limitado, sin variables de credenciales de producción. El fixture reemplazó los conectores externos; todos los movimientos fueron simulados. El esquema temporal se elimina al finalizar la suite y el runner confirmó que PostgreSQL quedó detenido.

Los 18 casos verificaron: repetición diez veces sin duplicar, rollback/reintento, IDs por plataforma, identidad global insensible a mayúsculas, preservación de históricos, movimientos sin ID y certeza limitada, actualización del timestamp, rechazo de históricos ambiguos, bootstrap/cursor vacío/fallido/disjunto, bloqueo por plataforma, corridas interrumpidas, concurrencia, reuso protegido de `run_id` y activación de RLS.

### Ensayo final de migración, preflight, reparación y permisos

La validación local se amplió sobre la misma instancia temporal, siempre por socket con permisos `0700`, sin TCP ni variables de credenciales de producción. El resultado completo fue **287/287 pruebas de backend, sin omisiones**. Se verificó que los esquemas temporales y los roles `anon`/`authenticated` creados por el fixture no existían antes ni después de la corrida; PostgreSQL quedó detenido.

- **Migración sobre históricos:** 10.000 transacciones simuladas y 1.000 jugadores, aplicando la migración 125 dos veces. Huellas y snapshots confirmaron preservación de transacciones históricas, jugadores, corridas, rangos y cursores. Una colisión impide la migración completa sin dejar cambios parciales; otra prueba verifica que un escritor concurrente provoca un aborto acotado por `lock_timeout`, conservando el esquema anterior. Esto no estima tiempos para el volumen de producción.
- **RLS efectivo:** se simularon los grants por defecto en un esquema temporal. La migración revoca permisos de tablas y secuencia. Se probaron consultas como `anon` y `authenticated`, rechazadas. Restaurando intencionalmente grants solo en ese esquema descartable, RLS continuó ocultando filas y rechazando inserciones/modificaciones; no se deshabilitó RLS ni se alteró ninguna configuración de producción.
- **Observabilidad:** se verificó persistencia de valores no cero en `tx_invalid` y `tx_excluded`, manteniendo cobertura limitada. Un `EXPLAIN ANALYZE` con el fixture de 10.000 filas comprobó el uso del índice `LOWER(agente)` para una búsqueda selectiva.
- **Preflight corregido:** consulta la tabla resuelta en el esquema actual, detecta agregados NULL como diferencias y enumera solo candidatos al backfill. Detecta colisiones de ID y sin ID contra filas ya clasificadas en la plataforma destino, evitando falsos positivos entre plataformas distintas. El archivo real se ejecutó antes y después de la migración; una escritura accidental inyectada únicamente en memoria fue rechazada por `READ ONLY`.
- **Reparación corregida:** el reporte ahora cuenta fechas además de importes y cantidades, conserva una foto de todas las columnas y verifica metadatos, jugadores sin fuente y `updated_at`. No se cambió la semántica de asignación, no se habilitó el bloque opcional agente/plataforma y el archivo conserva su `ROLLBACK` final.
- **Reparación ensayada:** fixtures con mayúsculas mixtas, múltiples plataformas y agentes, históricos sin plataforma, jugador inactivo inflado, fechas incorrectas, datos ya correctos, jugador sin fuente y movimiento entre agentes. Se comprobó corrección, idempotencia, preservación completa de metadatos y restauración exacta de snapshots tras el `ROLLBACK`. Un control negativo confirmó que el propio informe detecta alteraciones indebidas. Los locks permiten lectura, bloquean escrituras concurrentes y se liberan al hacer rollback.
- **Backfill ensayado:** el SQL real clasifica exclusivamente agentes inequívocos, deja `bigwin`/desconocidos y filas ya clasificadas intactos. Las colisiones por mayúsculas y por ID fallan con rollback completo. No se inventó una clasificación para `bigwin`.

Los scripts manuales se leyeron desde disco y se ejecutaron en una conexión dedicada. Para observar resultados, el test separa el `ROLLBACK` final, inspecciona dentro de la misma transacción y ejecuta ese terminador. Nunca reemplaza el archivo por una versión con `COMMIT`. Catorce controles sin DB comprueban que el detector distingue `ON COMMIT DROP` de una sentencia que cerraría la transacción; esa corrección se pidió a Claude durante la revisión.

El archivo `frontend/lib/__tests__/cloud-api.test.ts` tenía cinco `await` fuera de funciones async. Se corrigieron los imports y el aislamiento de mocks dentro de ese único archivo: sus 28 casos pasan, DB/tokens/Redis/cola permanecen simulados y el chequeo TypeScript completo terminó sin errores. La corrida combinada de frontend aprobó 97 casos en seis archivos. La primera invocación combinada quedó sin salida y se canceló; ejecutando el runner con `/usr/local/bin/node` explícito finalizó correctamente. No se cambió código de la aplicación para ocultar fallas de tests.

Evidencia final:

- `/private/tmp/wa-monitoring-sql-final-tests.log`: Jest completo, 287 aprobadas.
- `/private/tmp/wa-monitoring-sql-final-report.json`: preflight de conexión, limpieza de esquemas/roles y `stopped: true`.
- `/private/tmp/wa-monitoring-run-sql-final.py`: ejecución acotada con entorno limitado e inicio/apagado de la instancia temporal.
- `/private/tmp/wa-monitoring-vitest-sql-final.log`: resumen de la corrida combinada, 97 aprobadas.
- `/private/tmp/wa-monitoring-typecheck-sql-final.log`: sin errores, salida 0.

Pruebas reproducibles agregadas al repositorio:

- [Migración, preflight y RLS](../../tests/casino-connectors/sync-migration.pg.test.js).
- [Scripts manuales y rollback](../../tests/casino-connectors/sync-manual-sql.pg.test.js).

**Límites restantes:** el conjunto es sintético. Faltan el preflight de solo lectura en la base real, su volumen/ventana de mantenimiento, la clasificación histórica aprobada y las fechas de bootstrap. Las pruebas no conceden aprobación de producción. Los avisos visuales de desarrollo descritos abajo siguen documentados; esta ronda no modificó la interfaz.

### Validación visual final: Playwright desde terminal

Se usó Chromium headless con perfil temporal y sandbox del navegador activo, sobre `next dev --turbopack` en `127.0.0.1:4017`. No se usó Computer Use. La sesión admin fue sintética y firmada con un secreto de prueba exclusivo del servidor local. Playwright interceptó todas las API; solo se emitieron GET simulados. Las solicitudes externas se bloquearon en el fixture y no se conectó ninguna base de datos.

La prueba inicial con Webpack quedó bloqueada por su instrumentación `eval`. Se mantuvo la CSP y se usó Turbopack, que permitió hidratar y probar la interfaz. Durante la validación se detectó y corrigió un problema real de nonce: middleware ahora reenvía al render de Next la misma CSP que entrega en la respuesta y RootLayout pasa el nonce a ThemeProvider. Las directivas de la política y el control de autenticación permanecen iguales. Esta propagación sigue la [guía oficial de CSP de Next.js](https://nextjs.org/docs/app/guides/content-security-policy). Ocho pruebas nuevas verifican aislamiento por solicitud, rechazo de encabezados enviados por el cliente, propagación y SSR; Playwright confirmó también que los scripts inline reales llevan el nonce esperado.

Se revisaron capturas de overview, cobertura izquierda/derecha, corridas y filas históricas. Los tres anchos son 1440, 390 y 320 px. Se corrigieron nombres largos de agentes que salían de las alertas y controles móviles que partían sus etiquetas; la medición final no detecta desbordes en página ni alertas. Las tablas mantienen desplazamiento horizontal dentro de sus tarjetas; hay un aviso móvil para descubrir las columnas fuera de vista. Algunas columnas requieren desplazamiento también en desktop.

Los checks del navegador aprobaron: fallo efectivo conservado tras intento omitido, corrida interrumpida, cobertura limitada y agente sin sincronizar, tres severidades de alerta, actualización, paginación, estado vacío, 403 sin tablas y error de red con recuperación. No hubo excepciones JavaScript no capturadas.

**Limitaciones visibles de desarrollo:** Next muestra dos avisos: React no puede usar `eval` para depuración con la CSP vigente y hay un aviso de hidratación del atributo nonce de `<style>`. La fuente Google Fonts también está bloqueada por la política actual, por lo que las capturas usan la tipografía alternativa. Esos avisos están registrados, no suprimidos, y el badge de Next puede verse sobre la navegación inferior. El 403 y el error de red son fallos simulados intencionales. Las capturas no sustituyen una prueba contra datos reales ni una validación del despliegue.

Artefactos locales de esta corrida:

- `/private/tmp/wa-monitoring-visual/desktop-overview.png`
- `/private/tmp/wa-monitoring-visual/mobile-overview.png`
- `/private/tmp/wa-monitoring-visual/mobile-small-overview.png`
- `/private/tmp/wa-monitoring-visual/report.json` (18 capturas, comprobaciones, medidas y consola).
- `/private/tmp/wa-monitoring-vitest-visual-final.log`, `/private/tmp/wa-monitoring-build-visual-final.log` y `/private/tmp/wa-monitoring-typecheck-visual-final.log`.

Script reproducible: [scripts/qa/monitoreo-visual.cjs](../../scripts/qa/monitoreo-visual.cjs). Usa exclusivamente el origen local indicado; requiere un navegador Playwright instalado. En esta máquina Playwright 1.59.1 se instaló en `/private/tmp/wa-monitoring-visual-tools` porque la copia de dependencias tenía un módulo incompleto; no se cambiaron las dependencias del proyecto.

```sh
# Terminal 1, desde frontend, sin .env ni conexión a producción:
AUTH_SECRET=monitoring-local-fixture-secret ./node_modules/.bin/next dev --turbopack --hostname 127.0.0.1 --port 4017
# Terminal 2, desde la raíz de la copia aislada:
MONITORING_PLAYWRIGHT_MODULE=/private/tmp/wa-monitoring-visual-tools/node_modules/playwright node scripts/qa/monitoreo-visual.cjs
```

PostgreSQL, Chromium de prueba y todos los servidores locales temporales quedaron detenidos.

## SQL para revisar antes de producción

### Cierre de revisión y paquete recuperable

Se exportó la rama de entrega a `/private/tmp/wa-monitoring-clean-20260913`, sin el
snapshot de los 37 cambios locales preexistentes ni archivos de entorno. En esa copia
se aprobaron TypeScript, los 97 casos de frontend y el build completo de Next.js,
incluida `/monitoreo`. Esto comprueba que la entrega no depende de esos cambios locales.
No se instalaron dependencias nuevas para esta comprobación: se copiaron las existentes.

Claude retomó la misma sesión dedicada y corrigió el runbook: ambas clases de colisiones
en la vuelta a índices antiguos, los bloqueos por ID de históricos sin plataforma y los
comandos de tests desde la raíz. Codex revisó el resultado y acotó la consulta de locks a
la base actual, distinguiendo corridas interrumpidas de procesos todavía activos.
El ensayo termina en `ROLLBACK`, conserva el historial y exige mantener el sync detenido
si se vuelve al código anterior, porque ese código reintroduce los problemas corregidos.

Se ejecutaron **tres comprobaciones adicionales** del SQL real del runbook en PostgreSQL
temporal: caso sin colisiones, colisión de ID entre plataformas y colisión sin ID entre
plataformas. La primera comprobó los índices restaurados dentro de la transacción; las
otras dos abortaron con la excepción prevista antes del DDL. En todos los casos el
rollback restituyó exactamente filas e índices y preservó las tablas de monitoreo.
Son controles adicionales, no se suman al conteo de 287 casos de Jest. No quedaron
esquemas ni roles temporales y PostgreSQL quedó detenido.

La copia recuperable se guarda en
`/Users/nicobegui/Desktop/whatsapp-automation-platform/tmp/entregas/centro-monitoreo-20260913`:
bundle incremental de Git, patch, los archivos de entrega, capturas y evidencia de
validación. La carpeta está ignorada por la regla existente `tmp/`; no modifica el
índice de Git ni los 37 archivos originales. No incluye `.env`, configuraciones de
permisos ni conversaciones de Claude. `LEEME.md` explica cómo revisar y recuperar la
rama en una copia aislada. El bundle requiere la base `8a218b8` que conserva el original.

La rotación de credenciales se difirió a pedido del usuario hasta terminar la jornada.
No se reutilizaron las credenciales expuestas ni se conectó a producción durante este
cierre. Rotación y acceso vigente siguen pendientes para la validación real.

- [Preflight de solo lectura](../../db/manual/125_preflight_readonly.sql).
- [Migración 125](../../db/migrations/125_casino_sync_monitoring.sql).
- [Clasificación de agentes inequívocos, termina en ROLLBACK](../../db/manual/125_backfill_platform_inequivocos.sql).
- [Reparación de agregados, termina en ROLLBACK](../../db/manual/125_repair_casino_players_aggregates.sql).
- [Procedimiento y rollback](centro-monitoreo.md).

## Pendientes antes de activar

1. La validación local está aprobada (287 backend, 97 frontend, TypeScript y build). Antes de acceder a producción, confirmar rotación de las credenciales que aparecieron en una salida anterior y autorizar un preflight de solo lectura mediante un acceso vigente. No pegar claves en conversaciones ni guardarlas en el repositorio. Acordar la ventana y límites de espera usando el volumen real.
2. Revisar preflight y aprobar clasificación histórica. `bigwin` es ambiguo entre Zeus y Bet30 y no se asigna automáticamente. Los rangos afectados quedan bloqueados hasta clasificar.
3. Aprobar el rango inicial de bootstrap por agente y verificar conexión directa o pooler de sesión (no transaccional) para el bloqueo del runner.
4. Aplicar migración, backfill/reparación y desplegar únicamente con aprobación explícita del usuario, siguiendo el runbook. El seed antiguo es incompatible con los nuevos índices y debe permanecer detenido.

No se ejecutó SQL en producción, no se desplegó, no se publicó ningún PR ni se enviaron mensajes externos. Esta es una entrega local para revisión; no una aprobación de despliegue.
