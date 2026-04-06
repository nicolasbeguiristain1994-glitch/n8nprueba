# Plantilla de Credenciales n8n

Este directorio documenta qué credenciales configurar en n8n y con qué parámetros.
**Nunca guardar valores reales aquí.**

---

## Supabase

**Tipo en n8n:** `Postgres` o `Supabase API`

| Campo | Valor |
|-------|-------|
| Host | `db.XXXXX.supabase.co` |
| Port | `5432` |
| Database | `postgres` |
| User | `postgres` |
| Password | *(desde Supabase → Settings → Database)* |
| SSL | `true` |

---

## Evolution API (WhatsApp)

**Tipo en n8n:** `HTTP Header Auth`

| Campo | Valor |
|-------|-------|
| Header Name | `apikey` |
| Header Value | *(tu API Key de Evolution)* |

---

## NOWPayments

**Tipo en n8n:** `HTTP Header Auth`

| Campo | Valor |
|-------|-------|
| Header Name | `x-api-key` |
| Header Value | *(desde NOWPayments dashboard)* |

---

## Sumsub (KYC)

**Tipo en n8n:** `HTTP Header Auth` + firma HMAC

| Campo | Descripción |
|-------|-------------|
| App Token | Desde Sumsub dashboard → Developers |
| Secret Key | Para firma de requests (ver docs Sumsub) |

---

## Notas de seguridad

- Todas las credenciales se configuran directamente en n8n UI (Settings → Credentials)
- n8n las encripta en su base de datos interna
- Al exportar workflows, usar **"Export without credentials"**
- Rotar credenciales cada 90 días o ante cualquier incidente
