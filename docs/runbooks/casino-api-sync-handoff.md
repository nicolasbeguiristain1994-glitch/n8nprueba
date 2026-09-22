# Entrega: sincronización de cuatro plataformas

## Alcance implementado

| Fase | Cambio | Hallazgos del plan |
|---|---|---|
| 1 | Agregados recalculados desde transacciones; jugador identificado por `(platform, username_lower)`; filtros y consumidores revisados; reautenticación una vez ante 401/403; fechas compartidas. | H1–H5, H11. La columna `platform` ya existía desde 123, pero su existencia no garantizaba que estuviera poblada. |
| 2 | Argenbet: Bearer, tres agentes confirmados, endpoint `/account-transfers/player`, páginas de 50 y jugador identificado por su rol. IDs compatibles con Excel y guardas contra colisiones. | H8–H10. La migración 126 ya había resuelto los centavos, `platform`, `source_id` y la deduplicación en transacciones; se reutilizaron, sin modificar el importador. |
| 3 | Ganamos: seis sesiones y cookies independientes, consultas de 24 horas, páginas de 500, horas interpretadas como UTC y error visible por agente. | La investigación del plan ya había confirmado endpoint, IDs y necesidad de sesión propia por agente. Quedaba implementar el conector. |
| 4 | Incremental con solapamiento de 30 minutos y recuperación de rangos pendientes; bloqueo por plataforma; pipeline de cuatro plataformas; historial de corridas, estado en dashboard y workflow cada 15 minutos. | H7 y fallos silenciosos del pipeline. Un error deja salida distinta de cero y no impide intentar las demás plataformas. |

H6 estaba parcialmente resuelto: `casino_transactions.monto` ya era `numeric(20,2)` en 126. Se conservaron centavos también en jugadores, normalización y consumidores. Bonos, Realtime y rediseño del dashboard quedaron fuera de alcance.

El código está distribuido en cuatro commits, uno por fase, sobre `wip/traspaso`. No se hizo push ni se incluyeron los cambios previos ajenos del usuario.

## Orden de instalación manual

1. Verificar que el esquema previo y **126_casino_excel_import.sql** ya estén aplicados. Si faltara 126, aplicarla primero.
2. Aplicar **127_casino_players_platform_identity.sql**.
3. Aplicar **128_casino_sync_runs.sql**.
4. Configurar las variables de entorno y desplegar el código actualizado.
5. Importar/actualizar **n8n/workflow-specs/WF-030-Casino-Daily-Sync.json** y activar únicamente ese scheduler de casino. Desactivar cualquier cron externo equivalente que hubiera sido configurado fuera del repositorio.
6. Verificar los estados del dashboard y realizar la validación real descrita abajo.

**No invertir 126 y 127**: 127 depende de columnas, índices y vistas de 126 y modifica esas vistas. El runner histórico de migraciones tiene una lista manual antigua; no asumir que ejecutarlo aplica estas migraciones recientes.

127 deja `platform=NULL` cuando la atribución es ambigua o hay una colisión. Esto incluye `bigwin` y los nombres compartidos entre Ganamos/Argenbet. No se adivina la plataforma ni se descartan filas. Revisar los avisos de la migración y los SELECT de diagnóstico del [informe técnico](casino-api-sync-implementation.md).

Ni las migraciones ni las cargas históricas fueron ejecutadas durante este trabajo.

## Variables de entorno

Configurar mediante Doppler o el entorno del servidor, nunca con valores reales en Git. Las entradas están documentadas en `.env.example`.

| Uso | Variables |
|---|---|
| Base de datos de los scripts | `DATABASE_URL` |
| Zeus | `ZEUS_API_KEY`, y `ZEUS_PLAYER_TOKEN` temporal o las credenciales de auto-login indicadas debajo |
| Bet30 | `BET30_API_KEY`, y `BET30_PLAYER_TOKEN` temporal o las credenciales de auto-login indicadas debajo |
| Auto-login Zeus | `ZEUS_ADMIN_USER`, `ZEUS_ADMIN_PASSWORD`, **`ZEUS_LOGIN_CLIENT_ID`, `ZEUS_LOGIN_CLIENT_SECRET`** |
| Auto-login Bet30 | `BET30_ADMIN_USER`, `BET30_ADMIN_PASSWORD`, **`BET30_LOGIN_CLIENT_ID`, `BET30_LOGIN_CLIENT_SECRET`** |
| Argenbet temporal | `ARGENBET_PLAYER_TOKEN` |
| Argenbet, adaptador de login pendiente | `ARGENBET_ADMIN_USER`, `ARGENBET_ADMIN_PASSWORD`; `loginUrl` en la configuración cuando se conozca el contrato |
| Ganamos, por agente | `GANAMOS_<AGENTE>_USER`, `GANAMOS_<AGENTE>_PASSWORD`; temporalmente puede usarse `GANAMOS_<AGENTE>_SESSION_COOKIE` |
| Bases opcionales | `ZEUS_API_BASE`, `BET30_API_BASE`, `ARGENBET_API_BASE`, `GANAMOS_API_BASE` |
| Scheduler, servidor | `CRON_SECRET`; `CRON_APP_URL` para el recálculo de prioridades del pipeline |
| Scheduler, n8n | `PLATFORM_BASE_URL`, `CASINO_CRON_SECRET` con el mismo valor de `CRON_SECRET` del servidor |

Los nombres de agente Ganamos para las variables son **ADMINBTC, ADMINZEUS, ADMINROYAL, ADMBIGWIN, AMDFARABET, ADMINIMPERIO**. Cada cookie debe proceder de la sesión del propio agente. Una cookie del administrador general no sustituye esas seis sesiones.

Los nuevos `*_LOGIN_CLIENT_ID` y `*_LOGIN_CLIENT_SECRET` sustituyen valores que estaban embebidos en la configuración de Zeus/Bet30. Deben configurarse para conservar el auto-login. El modo de token estático sigue disponible cuando no se configura auto-login.

## Login: datos que faltan

El login real de **Argenbet y Ganamos no fue inventado ni validado**. Los adaptadores están aislados e inyectables; usuario y contraseña solos todavía no implementan un login de producción. El funcionamiento temporal con token/cookie exige renovarlos manualmente al expirar.

Para cerrar los TODO se necesitan capturas sanitizadas del flujo de login de cada plataforma:

- URL y método HTTP de login; `Content-Type` y estructura del cuerpo, incluidos los nombres exactos de los campos.
- Headers necesarios: `Origin`, `Referer`, CSRF y cualquier paso previo que genere cookies o un token CSRF.
- Argenbet: estructura de la respuesta y ruta del JWT, expiración/TTL, y contrato de renovación o repetición del login.
- Ganamos: nombres y atributos de las cookies entregadas (`Set-Cookie`, dominio, path, expiración) y cómo cambia o renueva la sesión; confirmar el login por cada agente.
- Respuestas de éxito, credenciales inválidas y sesión expirada, incluyendo cualquier desafío adicional obligatorio.

Reemplazar contraseñas, tokens, cookies y otros valores secretos por marcadores en esas capturas. Los valores reales se configuran fuera del repositorio.

## Operación y validación

- El botón manual devuelve una solicitud **aceptada**, no un éxito anticipado. Consultar el estado de sincronización para conocer su resultado.
- El cron usa `POST /api/cron/casino-sync` y espera el resultado del pipeline. El botón usa `POST /api/dashboard/casino/sync`. Ambos comparten el mismo bloqueo por plataforma.
- Una segunda corrida de la misma plataforma se omite limpiamente mientras la primera mantiene el bloqueo. Un estado omitido no reemplaza el último resultado real.
- Ganamos recupera días pendientes dentro de su retención aproximada de 60 días y avisa si el último éxito supera siete días. El detalle más antiguo no puede reconstruirse a partir de los totales del panel.
- El bootstrap automático no equivale a una importación de todo el histórico. Para cargas históricas usar los rangos explícitos documentados; Excel sigue siendo el fallback sin cambios.

Pruebas realizadas con HTTP, PostgreSQL y procesos simulados; no se llamó a las APIs reales ni se aplicó SQL a una base real. La validación del propietario sigue pendiente: **Argenbet/adminroyal, agosto 2026: 1.715 transacciones, 184 jugadores, depósitos 22.898.554,00 y retiros 14.920.991,67**. Comparar también las repeticiones del mismo rango y la convivencia con un Excel ya importado.

### Resultado de pruebas al cierre

- Raíz: **312 aprobadas, 1 omitida** (`npm test -- --runInBand`).
- Frontend: **856 aprobadas, 6 omitidas** (`npx vitest run`).
- TypeScript: correcto (`npx tsc --noEmit --incremental false`).

Las omisiones son de integración con base de datos. Las migraciones siguen
pendientes de aplicación y validación por el propietario.
