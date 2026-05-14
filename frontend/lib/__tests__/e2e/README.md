# Tests E2E — Flujos de seguridad críticos

Suite de tests end-to-end que validan flujos completos de seguridad conducidos por requests HTTP reales. A diferencia de los tests unitarios (que prueban piezas aisladas), estos tests ejercitan el route handler, el sistema de permisos, el rate limiter y el logger de seguridad como una unidad.

## Archivos y flujos cubiertos

### `login-ratelimit.test.ts` — Flujo 1: Rate limiting por requests reales

A diferencia de `flows/auth-flow.test.ts` (que incrementa el contador directamente), este test hace 10+ POST reales al route handler y observa el resultado.

| Escenario | Resultado esperado |
|-----------|-------------------|
| 10 requests fallidos consecutivos | Cada uno devuelve 401 |
| Request #11 desde la misma IP | 429 con mensaje "Demasiados intentos" |
| IP bloqueada → consulta a DB | **No se consulta** (short-circuit) |
| Misma IP bloqueada, IP diferente | La IP alternativa sigue recibiendo 401 |
| IPs distintas en paralelo | Bloqueada=429, libre=401 en el mismo instante |
| Ventana de 15 min expira (fake timers) | IP puede volver a intentar (401, no 429) |
| Evento stdout al bloquear | `rate_limit_exceeded` con `level=SECURITY` e IP correcta |
| Eventos stdout antes del límite | **No se emite** `rate_limit_exceeded` |

### `permissions-rbac.test.ts` — Flujo 2: Autenticación y RBAC completo

Cubre casos que `flows/resource-flow.test.ts` no tiene: no-session, stale session y usuario desactivado.

| Escenario | Resultado esperado |
|-----------|-------------------|
| Sin cookie de sesión | 401 Unauthorized, sin consultar DB |
| Sin sesión → stdout | `session_invalid` con `reason=no_session` |
| Cookie válida, `session_version` desactualizado | 401 Session expired |
| Stale session → stdout | `session_invalid` con `reason=session_version_mismatch` |
| Usuario desactivado en DB (cookie válida) | 401 Unauthorized |
| Desactivado → stdout | `session_invalid` con `reason=user_not_found_or_inactive` |
| Operator sin sector requerido | 403 Forbidden |
| Sin sector → stdout | `access_denied` con `resource=campaigns` |
| Operator con sector correcto | 403 NO emitido, 200 OK |
| Viewer con sector correcto | 200 OK |
| Admin sin sectores | 200 OK (bypasa sector checks) |
| Admin con sector diferente al recurso | 200 OK |
| Secuencia stale→fresh | Stale→401, luego fresh session→200 |

### `user-management.test.ts` — Flujos 3 y 4: Admin + audit + securityLog

Cubre la instrumentación de `securityLog` agregada recientemente a `app/api/users/[id]/route.ts`.

**Flujo 3 — Cambio de rol:**

| Escenario | Resultado esperado |
|-----------|-------------------|
| Admin cambia rol de operator a admin | 200 OK |
| Audit del cambio | `action=update`, `resource=users`, `changedFields=['role']` |
| Stdout al cambiar rol | `user_role_changed` con `targetUserId` y `newRole` |
| Stdout al cambiar solo nombre (sin rol) | `user_role_changed` **no** emitido |

**Flujo 4 — Control de changedFields:**

| Escenario | Resultado esperado |
|-----------|-------------------|
| PATCH solo `name` | `changedFields=['name']`, sin `role` ni `is_active` |
| PATCH `role` + `sectors` | Ambos en `changedFields`, sin `name` ni `is_active` |
| PATCH `is_active=false` | `changedFields` incluye `is_active` |
| Desactivar → stdout | `user_deactivated` con `via=patch` |
| Activar (`is_active=true`) → stdout | `user_deactivated` **no** emitido |

**DELETE (soft-delete):**

| Escenario | Resultado esperado |
|-----------|-------------------|
| Admin soft-delete de operator | 200 OK |
| DELETE → stdout | `user_deactivated` con `via=delete` |
| Audit del DELETE | `action=delete`, `resource=users`, `resource_id` correcto |
| Intentar eliminar el único admin activo | 400 con mensaje específico |
| Usuario no encontrado | 404 |

**Secuencia completa:** cambio de rol → desactivación emiten eventos correctos sin interferencia cruzada.

## Cómo ejecutar

```bash
# Solo los tests E2E nuevos
npx vitest run lib/__tests__/e2e/

# Un archivo específico
npx vitest run lib/__tests__/e2e/login-ratelimit.test.ts
npx vitest run lib/__tests__/e2e/permissions-rbac.test.ts
npx vitest run lib/__tests__/e2e/user-management.test.ts

# Toda la suite (unitarios + flows + e2e)
npx vitest run
```

## Diferencia con `flows/`

| Directorio | Propósito |
|------------|-----------|
| `flows/` | Flujos conceptuales; setup manual del rate limiter y DB; documentan el comportamiento esperado |
| `e2e/` | Flujos conducidos enteramente por requests HTTP; validan la integración real entre capas |

## Helpers disponibles (`helpers/session.ts`)

| Helper | Uso |
|--------|-----|
| `makeSession(override?)` | Sesión viewer base |
| `makeAdminSession(override?)` | Sesión admin |
| `makeOperatorSession(sectors, override?)` | Sesión operator con sectores |
| `makeViewerSession(override?)` | Sesión viewer explícita |
| `makeReqWithSession(url, session, opts?)` | Request con cookie firmada |
| `makeReq(url, opts?)` | Request sin sesión |
| `adminPost(url, session, body)` | POST JSON con sesión |
| `adminPatch(url, session, body)` | PATCH JSON con sesión |
| `adminDelete(url, session)` | DELETE con sesión |
| `captureStdout(fn)` | Captura eventos NDJSON escritos a stdout durante `fn` |
