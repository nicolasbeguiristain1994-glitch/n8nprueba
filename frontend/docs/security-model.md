# Modelo de Seguridad — WA Platform

> Documento de referencia para el equipo actual y futuras incorporaciones.
> Refleja el estado real del proyecto a mayo 2026.

---

## Tabla de contenidos

1. [Autenticación](#1-autenticación)
2. [Autorización y RBAC](#2-autorización-y-rbac)
3. [Rate Limiting](#3-rate-limiting)
4. [Validación de Inputs](#4-validación-de-inputs)
5. [Auditoría y Logging](#5-auditoría-y-logging)
6. [Monitoreo y Alertas](#6-monitoreo-y-alertas)
7. [Protecciones Web](#7-protecciones-web)
8. [Manejo de Errores](#8-manejo-de-errores)
9. [Secrets y Configuración](#9-secrets-y-configuración)
10. [Limitaciones y Riesgos Conocidos](#10-limitaciones-y-riesgos-conocidos)

---

## 1. Autenticación

### Flujo de login

1. El cliente envía `POST /api/auth/login` con `{ email, password }`.
2. El servidor verifica el rate limit por IP antes de tocar la base de datos.
3. Se busca el usuario en la tabla `users` por email (case-insensitive).
4. Se compara la contraseña con `bcryptjs.compare()` contra el `password_hash` almacenado.
5. Si todo es válido, se genera un JWT firmado con `AUTH_SECRET` y se establece como cookie.
6. Al logout (`POST /api/auth/logout`) la cookie se elimina con `maxAge=0`.

### Cookie de sesión

| Atributo    | Valor                                          |
|-------------|------------------------------------------------|
| `HttpOnly`  | `true` — inaccesible desde JavaScript          |
| `Secure`    | `true` en producción — solo sobre HTTPS        |
| `SameSite`  | `strict` — bloquea envío en requests cross-site |
| `Max-Age`   | 7 días (604 800 segundos)                       |
| `Path`      | `/`                                            |

**Por qué `SameSite=strict`:** el CRM es una aplicación interna sin navegación cross-site esperada. `strict` elimina el vector CSRF sin necesidad de tokens adicionales.

### Contenido del JWT

El token contiene el payload `SessionUser` firmado con HS256:

```typescript
{
  user_id:               string   // UUID del usuario (o 'bootstrap')
  email:                 string
  name:                  string
  role:                  'admin' | 'operator' | 'viewer'
  sectors:               string[]
  session_version:       number   // incrementado al cambiar contraseña/rol
  can_download_contacts: boolean
  allowed_agents:        string[]
  iat:                   number   // issued at (Unix timestamp)
  exp:                   number   // expiry = iat + 7 días
  nonce:                 string   // UUID aleatorio por sesión
}
```

> **Importante:** los valores de `role` y `sectors` del JWT son solo referencia de interfaz. En cada request protegido, `checkPermissionWithUser` re-consulta la DB para obtener el estado fresco. Un cambio de rol o desactivación de cuenta tiene efecto inmediato sin necesidad de revocar el token.

### Invalidación de sesiones

Cada usuario tiene un campo `session_version` en la DB. Si `dbUser.session_version !== session.session_version`, el request recibe `401 Session expired`. Este campo se incrementa al cambiar contraseña o cuando un admin edita el rol/sectores del usuario.

### Modo bootstrap

Cuando la tabla `users` está vacía (primer arranque), el sistema activa un usuario de emergencia configurado via variables de entorno:

- `AUTH_USERNAME` — email del usuario bootstrap
- `AUTH_PASSWORD` — contraseña en texto plano (comparación directa)

**Restricciones del bootstrap:**
- Solo funciona mientras `COUNT(*) FROM users = 0`.
- En cuanto se crea el primer usuario en la DB, cualquier sesión bootstrap recibe `401 Session expired`.
- No tiene `user_id` real (se almacena como `NULL` en la auditoría).

---

## 2. Autorización y RBAC

### Roles

| Rol        | Descripción                                                  |
|------------|--------------------------------------------------------------|
| `admin`    | Acceso total a todos los recursos y acciones                 |
| `operator` | Acceso a recursos asignados vía sectores; sin borrar ni gestionar |
| `viewer`   | Solo lectura en los recursos de sus sectores                 |

### Acciones disponibles

`read` · `create` · `update` · `delete` · `manage` · `send` · `assign` · `transfer`

### Reglas fijas (independientes de sectores)

- `delete` y `manage` son **siempre admin-only**, independientemente del rol o sectores.
- Los recursos `users`, `audit` y `blacklist` son **siempre admin-only**.
- Los `admin` bypasan todas las verificaciones de sector.

### Matriz de permisos por rol

| Acción    | admin | operator (con sector) | viewer (con sector) |
|-----------|-------|-----------------------|---------------------|
| `read`    | ✅    | ✅                    | ✅                  |
| `create`  | ✅    | ✅                    | ❌                  |
| `update`  | ✅    | ✅                    | ❌                  |
| `send`    | ✅    | ✅                    | ❌                  |
| `delete`  | ✅    | ❌                    | ❌                  |
| `manage`  | ✅    | ❌                    | ❌                  |

### Sectores

Un sector es una etiqueta que otorga acceso a un recurso específico. Los sectores disponibles son:

`dashboard` · `contacts` · `campaigns` · `conversations` · `lines` · `warmup` · `users` · `lists` · `send` · `audit` · `settings` · `tickets` · `blacklist` · `tasks` · `estadisticas` · `automations` · `templates`

Un operator con sectores `['campaigns', 'contacts']` puede leer, crear y actualizar campañas y contactos, pero no puede acceder a `lines`, `settings` ni a ningún recurso no listado.

### Verificación en rutas

Todas las rutas protegidas usan uno de estos dos patrones:

```typescript
// Patrón 1 — cuando se necesita el usuario autenticado
const auth = await checkPermissionWithUser(req, 'campaigns', 'read')
if (!auth.ok) return auth.response
const user = auth.user  // role/sectors frescos de la DB

// Patrón 2 — cuando solo se necesita la verificación
const err = await checkPermission(req, 'lines', 'manage')
if (err) return err
```

`checkPermissionWithUser` realiza una query a la DB en cada request para obtener `role`, `sectors`, `is_active` y `session_version` frescos. Esto garantiza que cambios de configuración (desactivar cuenta, cambiar sectores) tengan efecto inmediato.

### Propiedad de recursos (row-level)

Para campañas y listas de contactos existe un control adicional de propiedad (`isOwnerOrAdmin`):

- `admin` ve todos los recursos (incluyendo los históricos sin propietario).
- Recursos sin propietario (`created_by = NULL`) son admin-only.
- Un operator/viewer solo accede a sus propios recursos.

---

## 3. Rate Limiting

### Configuración actual

| Parámetro        | Valor                              |
|------------------|------------------------------------|
| Máximo intentos  | 10 por IP                          |
| Ventana          | 15 minutos                         |
| Clave            | IP del cliente (`x-forwarded-for`) |
| Reset            | Al login exitoso                   |

**Comportamiento:**
- El contador se incrementa solo en intentos fallidos (usuario no encontrado, contraseña incorrecta, cuenta inactiva, bootstrap inválido).
- Un login exitoso resetea el contador de la IP.
- Una IP bloqueada recibe `429` con el mensaje `"Demasiados intentos. Intentá de nuevo en 15 minutos."` — la DB no se consulta.
- La ventana expira naturalmente pasados los 15 minutos.

### Arquitectura — interfaz intercambiable

El rate limiter expone la interfaz `RateLimiterAdapter`:

```typescript
interface RateLimiterAdapter {
  isBlocked(key: string): Promise<boolean> | boolean
  increment(key: string): Promise<void>   | void
  reset(key: string):     Promise<void>   | void
}
```

Hay dos implementaciones disponibles en `lib/rate-limit.ts`:

#### `MemoryRateLimiter` — backend actual

Estado en el heap del proceso Node.js. Activo cuando `REDIS_URL` no está definida.

| Pros | Contras |
|------|---------|
| Sin dependencias externas | Se reinicia al reiniciar el servidor |
| Latencia cero | No compartido entre instancias |
| Funciona offline | Un atacante puede distribuir intentos entre pods |

#### `RedisRateLimiter` — backend distribuido

Estado en Redis usando `INCR` + `EXPIRE` enviados en pipeline (atómicos en un solo roundtrip). Activo automáticamente cuando `REDIS_URL` está definida.

| Pros | Contras |
|------|---------|
| Sobrevive reinicios del servidor | Requiere Redis disponible |
| Compartido entre todas las instancias | ~1 ms de latencia adicional por check |
| Resistente a ataques distribuidos | Fail-open ante caídas de Redis |

**Comportamiento de ventana:** el `EXPIRE` se renueva en cada intento fallido. Un atacante que sigue probando permanece bloqueado 15 minutos desde su último intento, no desde el primero. Esto es más estricto que una ventana fija.

**Selección automática del backend:**

```typescript
// lib/rate-limit.ts — factory que elige según entorno
function createLoginRateLimiter(): RateLimiterAdapter {
  if (process.env.REDIS_URL) return new RedisRateLimiter(config, 'rl:login')
  return new MemoryRateLimiter(config)
}

export const loginRateLimiter = createLoginRateLimiter()
```

El código consumidor (login route, tests) usa siempre `loginRateLimiter` — no sabe ni le importa qué backend está activo.

### Modo fail-open en RedisRateLimiter

Si Redis no está disponible, `isBlocked()` retorna `false` (permite el login). Esta es una decisión de disponibilidad sobre seguridad: es preferible que el login funcione durante una caída de Redis que bloquearlo completamente. Si el proyecto requiere el comportamiento inverso (fail-closed), cambiar `return false` por `return true` en el catch de `isBlocked`.

### Cuándo migrar a Redis

Activar `RedisRateLimiter` configurando `REDIS_URL` en Doppler. El cliente `redis` ya es dependencia del proyecto (BullMQ). No requiere código adicional.

---

## 4. Validación de Inputs

### Flujo centralizado con Zod

Todos los schemas están definidos en `lib/schema.ts`. El patrón de uso en rutas es:

```typescript
const rawBody = await req.json().catch(() => null)
const parsed  = parseBody(SomeSchema, rawBody)
if (!parsed.ok) return handleValidationError(req, parsed.error, 'resource-name')
```

`parseBody<T>(schema, data)` retorna un discriminated union:
- `{ ok: true, data: T }` — datos validados y tipados
- `{ ok: false, error: ZodError }` — error de validación

### Respuesta de error de validación (400)

```json
{
  "error": "Validation failed",
  "issues": [
    { "path": "name",     "message": "Required" },
    { "path": "category", "message": "Invalid enum value" }
  ]
}
```

`handleValidationError` también:
- Registra un evento de auditoría con los campos fallidos.
- Emite un evento `validation_failed` vía `securityLog` (JSON estructurado a stdout).

### Principios aplicados

- **Schemas estrictos:** los schemas de actualización usan `.strict()` en Zod para rechazar campos desconocidos.
- **Enums explícitos:** los valores como `status`, `category`, `role` están definidos como enums Zod — cualquier valor fuera del set retorna 400.
- **Validación en el perímetro:** la validación ocurre antes de cualquier lógica de negocio o acceso a la DB.

---

## 5. Auditoría y Logging

### Tabla de auditoría

Todas las acciones significativas se registran en la tabla `rbac_audit_log`:

| Columna       | Descripción                                      |
|---------------|--------------------------------------------------|
| `user_id`     | UUID del usuario (NULL para bootstrap)           |
| `user_email`  | Email al momento del evento                      |
| `user_role`   | Rol al momento del evento                        |
| `action`      | Acción realizada (ver lista abajo)               |
| `resource`    | Recurso afectado (`campaigns`, `users`, etc.)    |
| `resource_id` | ID del recurso específico (cuando aplica)        |
| `status`      | `success` · `failure` · `denied`                 |
| `ip_address`  | IP del cliente (via `x-forwarded-for`)           |
| `user_agent`  | User-Agent del request                           |
| `metadata`    | JSONB con contexto adicional                     |

### Acciones auditadas

| Acción                | Cuándo se registra                                      |
|-----------------------|---------------------------------------------------------|
| `login_success`       | Login exitoso (DB o bootstrap)                          |
| `login_failed`        | Credenciales inválidas (`user_not_found`, `password_mismatch`, `account_inactive`) |
| `rate_limit_exceeded` | IP bloqueada por exceso de intentos                     |
| `create`              | Creación de templates, campañas, usuarios, etc.         |
| `update`              | Actualización de recursos (incluye `metadata.fields`)   |
| `delete`              | Eliminación de recursos                                 |
| `manage`              | Operaciones administrativas (lines, onboarding, etc.)  |

### Sanitización de metadata

El sanitizador de auditoría bloquea automáticamente claves sensibles antes de escribir en la DB:

`password` · `password_hash` · `token` · `secret` · `authorization` · `cookie` · `apikey` · `api_key` · `apisecret` · `api_secret`

Los valores de tipo string se truncan a 500 caracteres. La profundidad máxima de objetos anidados es 5 niveles.

### Comportamiento ante fallos

`audit()` nunca lanza excepciones — un fallo de escritura en el log no interrumpe el flujo del producto. Los errores se registran via `appLog('ERROR', 'audit write failed', ...)`.

### Logs de seguridad en servidor

Además de la tabla, se emiten logs estructurados al servidor en estos casos:

Los logs operacionales críticos (errores de DB, fallos de auditoría, errores de Redis, errores de la Cloud API) también emiten JSON estructurado via `appLog` (mismo módulo `lib/security-log.ts`):

```json
{ "level": "ERROR", "message": "audit write failed", "action": "create", "resource": "templates", "ts": "..." }
{ "level": "ERROR", "message": "login DB error", "error": "...", "ip": "...", "ts": "..." }
{ "level": "ERROR", "message": "redis rate-limiter connect failed", "error": "...", "ts": "..." }
{ "level": "ERROR", "message": "[cloud/templates POST]", "error": "...", "ts": "..." }
{ "level": "WARN",  "message": "[cloud/templates POST] marketing template created", "name": "...", "wabaId": "...", "ts": "..." }
```

---

## 6. Monitoreo y Alertas

### Logger de eventos de seguridad

Todos los eventos de seguridad se emiten como **JSON estructurado a stdout** desde `lib/security-log.ts`. Cada línea es un objeto JSON independiente (NDJSON), compatible con Datadog, Loki, CloudWatch Logs Insights y cualquier herramienta que ingeste logs de contenedor.

Formato de cada línea:

```json
{
  "level": "SECURITY",
  "event": "access_denied",
  "ip": "203.0.113.42",
  "userId": "uuid-del-usuario",
  "role": "operator",
  "resource": "settings",
  "action": "manage",
  "ts": "2026-05-14T14:30:00.000Z"
}
```

El campo `level: "SECURITY"` permite filtrar todos los eventos de seguridad con una sola condición. Los eventos operacionales usan `level: "ERROR"`, `"WARN"` o `"INFO"` a través de `appLog`.

### Catálogo completo de eventos

#### Eventos de seguridad (`level: "SECURITY"`)

| Evento                | Cuándo se emite                                                    | Campos clave                                    |
|-----------------------|--------------------------------------------------------------------|-------------------------------------------------|
| `login_failed`        | Credenciales incorrectas o cuenta inactiva                        | `ip`, `email`, `reason`                         |
| `login_success`       | Login exitoso con usuario de DB                                   | `ip`, `userId`, `email`, `role`                 |
| `rate_limit_exceeded` | IP bloqueada por superar 10 intentos fallidos en 15 min           | `ip`                                            |
| `bootstrap_login`     | Login con credenciales de emergencia (DB vacía)                   | `ip`, `email`                                   |
| `access_denied`       | Sesión válida pero sin permiso RBAC para el recurso (403)         | `ip`, `userId`, `role`, `resource`, `action`    |
| `session_invalid`     | Token inválido, usuario desactivado o `session_version` desfasada | `ip`, `userId`, `reason`, `resource`            |
| `validation_failed`   | Payload con campos inválidos o faltantes en la API                | `ip`, `resource`, `fields`                      |
| `user_role_changed`   | Admin cambia el rol de otro usuario                               | `targetUserId`, `newRole`                       |
| `user_deactivated`    | Usuario desactivado (soft-delete o PATCH `is_active=false`)       | `targetUserId`, `via` (`"delete"` / `"patch"`)  |

Razones posibles en `reason`:

- `login_failed`: `user_not_found` · `account_inactive` · `password_mismatch` · `bootstrap_credentials_invalid`
- `session_invalid`: `no_session` · `user_not_found_or_inactive` · `session_version_mismatch` · `bootstrap_expired`
- `access_denied`: `bootstrap_forbidden` _(o ausente cuando es RBAC estándar)_

#### Eventos operacionales (`level: "ERROR"` / `"WARN"`)

Estos eventos no son de seguridad directa, pero su ausencia o acumulación puede indicar degradación del sistema de seguridad:

| `message`                                        | `level` | Cuándo ocurre                                              |
|--------------------------------------------------|---------|-------------------------------------------------------------|
| `login DB error`                                 | ERROR   | DB inalcanzable durante login — usuarios no pueden entrar  |
| `login last_login_at update failed`              | WARN    | Error no crítico actualizando timestamp de último login     |
| `audit write failed`                             | ERROR   | Falla al escribir en `rbac_audit_log` — audit trail roto   |
| `redis rate-limiter connect failed`              | ERROR   | Redis inalcanzable — rate limiter opera en modo fail-open  |
| `GET /api/users/[id] failed`                     | ERROR   | Error inesperado en lectura de usuario                     |
| `PATCH /api/users/[id] failed`                   | ERROR   | Error inesperado en actualización de usuario               |
| `DELETE /api/users/[id] failed`                  | ERROR   | Error inesperado en desactivación de usuario               |
| `[cloud/messages POST]`                          | ERROR   | Error no controlado al enviar mensaje vía Cloud API        |
| `[cloud/numbers POST]`                           | ERROR   | Error al refrescar calidad de número desde Meta            |
| `[cloud/onboard]`                                | ERROR   | Error durante el onboarding de Coexistence                 |
| `[cloud/sync POST]`                              | ERROR   | Error al disparar sincronización SMB                       |
| `[cloud/templates GET]`                          | ERROR   | Error al listar plantillas del WABA                        |
| `[cloud/templates POST]`                         | ERROR   | Error al crear plantilla en Meta                           |
| `[cloud/templates DELETE]`                       | ERROR   | Error al eliminar plantilla del WABA                       |
| `[cloud/templates POST] marketing template created` | WARN | Creación de plantilla MARKETING (costo mayor, opt-in requerido) |

### Análisis de brechas (gaps de cobertura actual)

Las siguientes acciones relevantes para seguridad **no generan logs stdout** en la versión actual. Son candidatas para instrumentar en fases futuras:

| Acción                               | Ruta                                 | Impacto si no se monitorea                              |
|--------------------------------------|--------------------------------------|---------------------------------------------------------|
| Descarga de contactos (CSV export)   | `GET /api/contacts?download=true`    | Exfiltración de datos no detectable en tiempo real      |
| Inicio/pausa/cancelación de campaña  | `PATCH /api/campaigns/[id]`          | Abuso de envíos masivos sin trazabilidad inmediata      |
| Creación de nuevo usuario            | `POST /api/users`                    | Creación de cuentas backdoor no alertada                |
| Cambio de contraseña propia          | `PATCH /api/users/[id]`              | Cubierto por `user_role_changed` pero no tiene evento propio |
| Mensajes enviados vía API Cloud      | `POST /api/cloud/messages`           | Volumen anómalo de mensajes no detectable en tiempo real |

### Catálogo de alertas por severidad

#### Críticas — respuesta inmediata

| Alerta                                    | Condición                                                                 | Acción                                        |
|-------------------------------------------|---------------------------------------------------------------------------|-----------------------------------------------|
| Login bootstrap en producción             | `event=bootstrap_login` → cualquier ocurrencia                           | Rotar `AUTH_PASSWORD`, crear usuario DB admin |
| Redis inactivo con rate limit abierto     | `message="redis rate-limiter connect failed"` → cualquier ocurrencia      | Restaurar Redis, monitorear logins manuales   |
| Audit trail roto                          | `message="audit write failed"` → ≥3 eventos en 5 min                     | Verificar conectividad DB, revisar logs       |

#### Altas — respuesta en < 1 hora

| Alerta                                    | Condición                                                                 | Acción                                        |
|-------------------------------------------|---------------------------------------------------------------------------|-----------------------------------------------|
| Brute force de login                      | `event=login_failed` AND misma `ip` → ≥5 en 5 min                       | Bloquear IP a nivel de infraestructura        |
| Cambio de rol a admin                     | `event=user_role_changed` AND `newRole=admin`                            | Verificar que el cambio fue autorizado        |
| Desactivación masiva de usuarios          | `event=user_deactivated` → ≥3 en 10 min                                 | Verificar si es ataque a la cuenta admin      |
| DB inalcanzable en login                  | `message="login DB error"` → ≥2 en 2 min                                | Verificar pool de conexiones y DB             |

#### Medias — respuesta en < 4 horas

| Alerta                                    | Condición                                                                 | Acción                                        |
|-------------------------------------------|---------------------------------------------------------------------------|-----------------------------------------------|
| Rate limit activado repetidamente         | `event=rate_limit_exceeded` → ≥3 en 1 hora misma IP                     | Investigar si es ataque sostenido             |
| 403 repetidos por el mismo usuario        | `event=access_denied` AND mismo `userId` → ≥10 en 10 min                | Revisar rol asignado o intento de escalada    |
| Sesiones inválidas masivas                | `event=session_invalid` AND `reason=session_version_mismatch` → ≥5 en 5 min | Puede indicar rotación masiva de sesiones  |
| Usuario desactivado intenta acceder       | `event=session_invalid` AND `reason=user_not_found_or_inactive`          | Verificar si la cookie fue robada             |

#### Bajas — revisión en próximo turno

| Alerta                                    | Condición                                                                 | Acción                                        |
|-------------------------------------------|---------------------------------------------------------------------------|-----------------------------------------------|
| Validaciones fallidas en cascada          | `event=validation_failed` AND misma `ip` → ≥20 en 10 min               | Investigar si es fuzzing o cliente defectuoso |
| Sesiones sin autenticar                   | `event=session_invalid` AND `reason=no_session` → pico inusual           | Puede ser tráfico de bot o scraper            |
| Cambios de nombre/sectores frecuentes     | `event` en `rbac_audit_log` `action=update` → volumen inusual           | Revisar si es automatización o actividad rara |

### Filtros útiles por herramienta

**Datadog Logs:**
```
# Todos los eventos de seguridad
@level:SECURITY

# Brute force en curso
@level:SECURITY @event:login_failed | stats count by @ip | filter count > 5

# Cambios de rol a admin
@level:SECURITY @event:user_role_changed @newRole:admin
```

**CloudWatch Logs Insights:**
```
# Top IPs con login_failed
filter level = "SECURITY" and event = "login_failed"
| stats count(*) as attempts by ip
| sort attempts desc

# Errores operacionales de seguridad
filter level = "ERROR"
| stats count(*) by message
| sort count desc
```

**Loki / Grafana:**
```logql
# Todos los eventos de seguridad
{app="wa-platform"} | json | level="SECURITY"

# Alertar sobre bootstrap login
{app="wa-platform"} | json | level="SECURITY" | event="bootstrap_login"

# Errores de audit trail
{app="wa-platform"} | json | level="ERROR" | message="audit write failed"
```

### Guía mínima de implementación

#### Opción A — Loki + Grafana (self-hosted, Docker Compose)

Agrega al `docker-compose.yml` de producción:

```yaml
services:
  loki:
    image: grafana/loki:2.9.4
    ports: ["3100:3100"]
    command: -config.file=/etc/loki/local-config.yaml

  promtail:
    image: grafana/promtail:2.9.4
    volumes:
      - /var/lib/docker/containers:/var/lib/docker/containers:ro
      - ./promtail-config.yaml:/etc/promtail/config.yaml
    command: -config.file=/etc/promtail/config.yaml

  grafana:
    image: grafana/grafana:10.4.0
    ports: ["3000:3000"]
    environment:
      - GF_AUTH_ANONYMOUS_ENABLED=false
```

`promtail-config.yaml` mínimo para ingestar logs del contenedor Next.js:

```yaml
scrape_configs:
  - job_name: wa-platform
    docker_sd_configs:
      - host: unix:///var/run/docker.sock
        filters:
          - name: name
            values: ["wa-platform-frontend"]
    pipeline_stages:
      - json:
          expressions:
            level: level
            event: event
      - labels:
          level:
          event:
```

#### Opción B — Datadog (SaaS)

1. Instalar el Datadog Agent en el servidor con `DD_LOGS_ENABLED=true`.
2. Agregar al contenedor Next.js:
   ```yaml
   labels:
     com.datadoghq.ad.logs: '[{"source":"nodejs","service":"wa-platform"}]'
   ```
3. Los logs stdout en formato JSON son detectados automáticamente y sus campos (`level`, `event`, `ip`, etc.) se indexan como atributos. Sin parseo manual adicional.
4. Crear monitores en Datadog con las condiciones del catálogo de alertas de la sección anterior.

### Respuesta a incidentes — referencia rápida

#### `bootstrap_login` detectado

1. Acceder a Doppler y rotar `AUTH_PASSWORD` de inmediato.
2. Crear un usuario admin en la DB via `POST /api/users` (o script SQL).
3. Verificar en `rbac_audit_log` si hubo acciones realizadas durante la sesión bootstrap.
4. Si el acceso no fue autorizado: revocar sesiones activas cambiando `session_version` de todos los usuarios en la DB.

#### Brute force (`login_failed` acumulados)

1. Verificar en logs si la IP está siendo bloqueada por el rate limiter (`rate_limit_exceeded`).
2. Si el ataque continúa con IPs rotativas: agregar bloqueo a nivel de Nginx/firewall externo.
3. Revisar si algún login fue exitoso desde IPs cercanas al ataque (`login_success` con `ip` en el mismo rango).
4. Si hay compromiso: cambiar la contraseña del usuario afectado y revocar todas sus sesiones (`session_version + 1`).

#### `user_role_changed` a admin no esperado

1. Verificar en `rbac_audit_log` qué admin realizó el cambio (`user_id`, `user_email`).
2. Contactar al admin para confirmar que el cambio fue intencional.
3. Si no fue autorizado: revertir el rol y forzar logout del usuario escalado (`session_version + 1`).
4. Investigar si la cuenta del admin que realizó el cambio está comprometida.

#### `audit write failed` persistente

1. Verificar conectividad entre la aplicación y PostgreSQL.
2. Revisar si la tabla `rbac_audit_log` existe y tiene las columnas correctas.
3. Comprobar que el pool de conexiones no está agotado (`PGSSLMODE`, `DATABASE_URL` en Doppler).
4. Mientras el audit trail esté roto, los logs stdout son el único registro — asegurarse de que están siendo persistidos.

#### `redis rate-limiter connect failed`

1. Verificar que el servicio Redis está activo y accesible desde la aplicación.
2. Comprobar `REDIS_URL` en Doppler apunta al host correcto.
3. El rate limiter opera en **fail-open** durante la outage: el login funciona sin bloqueo por intentos fallidos. Monitorear `login_failed` manualmente.
4. Restaurar Redis — el rate limiter se reconecta automáticamente al próximo intento.

### Eventos también en la tabla de auditoría

Los eventos `login_failed`, `login_success`, `rate_limit_exceeded`, `validation_failed`, `user_role_changed` y `user_deactivated` se persisten adicionalmente en `rbac_audit_log` (tabla PostgreSQL). Los logs stdout son complementarios: sirven para alertas en tiempo real; la tabla sirve para auditorías históricas y compliance.

---

## 7. Protecciones Web



### Headers de seguridad

Aplicados por el middleware en **todas** las respuestas (páginas y APIs):

| Header                            | Valor                                                |
|-----------------------------------|------------------------------------------------------|
| `X-Content-Type-Options`          | `nosniff`                                            |
| `X-Frame-Options`                 | `DENY`                                               |
| `Referrer-Policy`                 | `strict-origin-when-cross-origin`                    |
| `X-Permitted-Cross-Domain-Policies` | `none`                                             |
| `Permissions-Policy`              | `camera=(), microphone=(), geolocation=()`           |
| `Strict-Transport-Security`       | `max-age=31536000; includeSubDomains`                |
| `Cross-Origin-Opener-Policy`      | `same-origin`                                        |
| `Cross-Origin-Resource-Policy`    | `same-origin`                                        |
| `Content-Security-Policy`         | Ver detalle abajo                                    |

### Content Security Policy (CSP)

El CSP usa **nonces por request** generados con `crypto.randomBytes(16)`:

```
default-src 'self';
script-src 'self' 'nonce-<random>';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https:;
font-src 'self' data: https://fonts.gstatic.com;
connect-src 'self' wss: https:;
frame-ancestors 'none';
object-src 'none';
base-uri 'self';
```

- **`script-src`:** solo scripts del mismo origen y scripts con el nonce del request. Sin `'unsafe-inline'` ni `'unsafe-eval'`.
- **`style-src`:** `'unsafe-inline'` retenido — requerido por Tailwind CSS. Pendiente de migrar a next/font y extracción de CSS en build-time.
- **`frame-ancestors 'none'`:** equivalente al `X-Frame-Options: DENY`. Previene clickjacking.

### Protecciones ante ataques comunes

| Ataque        | Mecanismo de protección                                               |
|---------------|-----------------------------------------------------------------------|
| **XSS**       | CSP con nonces + `X-Content-Type-Options: nosniff`                    |
| **CSRF**      | `SameSite=strict` en la cookie de sesión                              |
| **Clickjacking** | `X-Frame-Options: DENY` + `frame-ancestors 'none'` en CSP         |
| **MIME sniffing** | `X-Content-Type-Options: nosniff`                                 |
| **Brute force login** | Rate limiting por IP (10 intentos / 15 min)                  |
| **Session fixation** | Nonce único por sesión + `session_version` en DB              |
| **Info disclosure** | Errores genéricos al cliente; detalle solo en logs de servidor  |
| **HSTS stripping** | `Strict-Transport-Security` con 1 año + includeSubDomains       |
| **Spectre/XS-Leaks** | `Cross-Origin-Opener-Policy: same-origin`                     |

### CORS

No hay configuración CORS explícita — comportamiento intencional. El browser aplica same-origin por defecto. Las rutas de webhook (`/api/webhook/`, `/api/cloud/`) son server-to-server y no están sujetas a CORS. Agregar `Access-Control-Allow-Origin: *` sería un debilitamiento.

---

## 8. Manejo de Errores

### Política general

- Los errores internos (excepciones no controladas, errores de DB) retornan `{ "error": "Internal server error" }` al cliente con código `500`.
- El detalle del error (mensaje de excepción, query fallida) va a logs estructurados via `appLog('ERROR', ...)` — nunca al cliente.
- Nunca se exponen: stack traces, mensajes de error de PostgreSQL, rutas de archivos internas ni nombres de columnas.

### Errores de dominio (controlados)

Algunos errores tienen mensajes explícitos porque son esperados y útiles para el cliente:

| Tipo                       | Ejemplo de mensaje                                 | Código |
|----------------------------|----------------------------------------------------|--------|
| `OptOutError`              | `"El número está en la lista de exclusión"`        | 422    |
| `ConversationWindowError`  | `"La ventana de conversación está cerrada"`        | 422    |
| `RateLimitError`           | `"Rate limit de Meta alcanzado"`                   | 429    |
| `CloudApiError`            | Mensaje de la API de Meta                          | 502    |

Estos errores provienen de clases tipadas en `lib/cloud-api/errors.ts` — no son excepciones genéricas.

### Errores de validación

Retornan `400` con la estructura `{ error: "Validation failed", issues: [...] }`. Ver [sección 4](#4-validación-de-inputs).

### Errores de autenticación/autorización

| Situación                          | Código | Mensaje              |
|------------------------------------|--------|----------------------|
| Sin cookie de sesión               | `401`  | `"Unauthorized"`     |
| Token inválido o alterado          | `401`  | `"Unauthorized"`     |
| `session_version` desactualizada   | `401`  | `"Session expired"`  |
| Usuario desactivado en DB          | `401`  | `"Unauthorized"`     |
| Permiso insuficiente               | `403`  | `"Forbidden"`        |

---

## 9. Secrets y Configuración

### Variables de entorno requeridas

| Variable          | Descripción                                              |
|-------------------|----------------------------------------------------------|
| `AUTH_SECRET`     | Clave para firmar/verificar JWTs. Mínimo 32 chars aleatorios |
| `DATABASE_URL`    | Connection string de PostgreSQL                          |
| `AUTH_USERNAME`   | Email del usuario bootstrap (solo para primer arranque)  |
| `AUTH_PASSWORD`   | Contraseña del usuario bootstrap (texto plano)           |

### Gestión con Doppler

Los secretos se gestionan con [Doppler](https://doppler.com). Nunca se almacenan en `.env` files commiteados ni en el código fuente.

- El proyecto usa `doppler run -- <comando>` para inyectar variables al proceso.
- Los archivos `.env.local` o `.env.production` deben estar en `.gitignore`.

### Recomendaciones de rotación

- **`AUTH_SECRET`:** rotar si existe sospecha de compromiso. Al rotar, todos los tokens JWT existentes se invalidan automáticamente (ya no verifican). Los usuarios deberán iniciar sesión nuevamente. Doppler permite rotaciones atómicas sin downtime.
- **`AUTH_PASSWORD` (bootstrap):** solo relevante antes de crear el primer admin. Una vez creado, las credenciales bootstrap son inoperables.
- **Tokens de API de Meta/Evolution:** si se comprometen, revocar desde los paneles respectivos. Los tokens se almacenan en la tabla `cloud_number_tokens` (cifrado pendiente — ver sección 9).

### Secretos ausentes del código fuente

Verificado: no existen secretos hardcodeados. Las búsquedas en el código muestran que todos los valores sensibles se leen de `process.env.*`.

---

## 10. Limitaciones y Riesgos Conocidos

Estas son las áreas que requieren atención futura, ordenadas por prioridad:

### Alta prioridad

**Rate limiter distribuido — activar en producción multi-instancia**
- `RedisRateLimiter` está implementado y disponible. Se activa definiendo `REDIS_URL` en Doppler.
- Sin `REDIS_URL`, el sistema usa `MemoryRateLimiter` (in-memory): estado no compartido entre instancias y se pierde al reiniciar.
- **Acción:** definir `REDIS_URL` en el entorno de producción para activar el backend Redis automáticamente. No requiere cambios de código.

**Tokens de API sin cifrado en reposo**
- Los access tokens de Meta/Evolution se almacenan en la tabla `cloud_number_tokens` sin cifrado en la DB.
- Si la DB es comprometida, los tokens quedan expuestos.
- **Solución:** cifrar con AES-256-GCM usando una clave de cifrado separada (no `AUTH_SECRET`).

### Media prioridad

**`style-src: 'unsafe-inline'` en CSP**
- Requerido actualmente por Tailwind CSS (utility classes inline).
- **Solución:** migrar fuentes a `next/font` (ya pendiente) y evaluar extracción de CSS en build-time para eliminar `'unsafe-inline'`.

**`AUTH_PASSWORD` en texto plano**
- La contraseña del usuario bootstrap se compara con `===` (sin hash).
- Es aceptable dado que el bootstrap solo aplica cuando no hay usuarios en la DB y debe ser temporal.
- **Mitigación:** documentar que las credenciales bootstrap deben rotarse o eliminarse de Doppler una vez creado el primer admin.

**HSTS sin `preload`**
- El header `Strict-Transport-Security` incluye `max-age` e `includeSubDomains` pero no `preload`.
- **Solución futura:** verificar que todos los subdominios soporten HTTPS y solicitar inclusión en la lista de preload de Chrome ([hstspreload.org](https://hstspreload.org)).

### Baja prioridad / Mejoras de observabilidad

**Logs operacionales — cobertura parcial**
- Los errores internos de rutas de usuario (`/api/users/`), cloud API (`/api/cloud/`) y módulos core (audit, login, Redis) emiten JSON estructurado via `appLog`.
- Las rutas de webhook, campaign-distributor y otros workers aún pueden usar `console.error` en texto libre.
- **Mejora futura:** auditar rutas restantes y migrar a `appLog` para cobertura completa de búsqueda por campo en CloudWatch/Datadog.

**Sin alertas automáticas configuradas**
- Los eventos de seguridad están disponibles como JSON estructurado en stdout. Ver reglas de alerta recomendadas en [sección 6](#6-monitoreo-y-alertas).
- **Pendiente:** configurar las reglas en la herramienta de observabilidad del proyecto (Datadog, Loki, etc.).

**Rotación de nonces de sesión**
- El nonce en el JWT es fijo por sesión (generado al login). No se rota en cada request.
- Aceptable para el modelo actual; evaluar si se implementa renovación de token en background.
