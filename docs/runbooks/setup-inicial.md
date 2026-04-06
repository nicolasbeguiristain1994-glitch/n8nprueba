# Runbook: Setup Inicial del Entorno

**Audiencia:** Dev / Ops
**Última actualización:** 2026-04

---

## Pre-requisitos

- [ ] Acceso a instancia n8n (URL + credenciales básicas)
- [ ] Proyecto Supabase creado
- [ ] Instancia Evolution API levantada y con instancia WhatsApp vinculada
- [ ] Repo clonado localmente

---

## Paso 1 — Variables de entorno

```bash
cp n8n/env-examples/.env.example .env
# Editar .env con valores reales
```

---

## Paso 2 — Schema de base de datos

En Supabase SQL Editor, ejecutar en orden:

```bash
# Orden de ejecución:
db/schema/01_core.sql
# (agregar archivos subsiguientes cuando existan)
```

Verificar que las tablas existen:
```sql
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public' 
ORDER BY table_name;
```

---

## Paso 3 — Importar workflows en n8n

1. Ir a n8n UI → **Settings** → **Import**
2. Seleccionar archivos JSON de `/n8n/workflow-specs/`
3. Verificar que las credenciales están asignadas correctamente en cada workflow

---

## Paso 4 — Configurar credenciales en n8n

Ver `/n8n/credentials-template/README.md` para los parámetros de cada credencial.

Credenciales a configurar:
- [ ] Supabase (Postgres)
- [ ] Evolution API (HTTP Header Auth)
- [ ] NOWPayments (HTTP Header Auth)

---

## Paso 5 — Test de smoke

Ejecutar manualmente el workflow `OPS_health-check` y verificar que:
- [ ] Conexión a Supabase OK
- [ ] WhatsApp instance conectada
- [ ] Mensaje de prueba enviado al número de alertas

---

## Paso 6 — Activar workflows

Activar en orden:
1. Workflows de onboarding
2. Workflows de pagos
3. Workflows de retención
4. Workflows de risk

---

## Rollback

Si algo falla después de un deploy:
1. Desactivar todos los workflows en n8n
2. Identificar el workflow problemático en los logs de n8n
3. Reimportar la versión anterior del JSON desde Git
4. Reactivar workflows uno por uno

---

## Contactos

- Ops: *(completar)*
- Dev: *(completar)*
