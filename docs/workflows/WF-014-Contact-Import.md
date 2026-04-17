# Workflow Spec: WF-014 — Contact Import

> **Archivo n8n:** `exports/WF-014-Contact-Import.json`
> **Estado:** Ready
> **Versión:** 1.0
> **Última actualización:** 2026-04-13

---

## Descripción

Importa contactos desde tres fuentes: CSV (archivo base64 en el body), array JSON directo vía API, o archivo multipart. Normaliza teléfonos a E.164, deduplica contra la DB, inserta o actualiza contactos usando `upsert_contact()`, y registra el resultado completo en `import_logs`.

No envía mensajes — solo gestiona el ingreso de contactos al sistema.

---

## Trigger

| Campo | Valor |
|-------|-------|
| Tipo | Webhook |
| Método | POST |
| Path | `/webhook/import-contacts` |

---

## Modos de uso

### Modo 1 — CSV base64

```json
{
  "source": "csv",
  "filename": "clientes_abril.csv",
  "delimiter": ",",
  "data": "cGhvbmUsbmFtZQorNTQ5MTExMjM0NTY3OCxKdWFuIEdhcmPDrWE=",
  "mapping": {
    "phone": "Telefono",
    "first_name": "Nombre",
    "last_name": "Apellido"
  },
  "tags": ["importacion-abril", "campaña-promo"],
  "trigger_sequence": "onboarding-flow-default"
}
```

### Modo 2 — JSON directo

```json
{
  "source": "api",
  "contacts": [
    { "phone": "+5491112345678", "first_name": "Juan",  "last_name": "García", "tags": ["vip"] },
    { "phone": "+5491187654321", "first_name": "María", "last_name": "López"  }
  ],
  "trigger_sequence": null
}
```

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `source` | string | Sí | `csv` \| `api` |
| `data` | string | CSV | CSV codificado en base64 |
| `contacts` | array | API | Array de contactos |
| `mapping` | object | No | Mapeo de columnas CSV. Default: `{phone: "phone", first_name: "name"}` |
| `tags` | array | No | Tags a agregar a todos los contactos importados |
| `trigger_sequence` | string | No | Nombre de secuencia a iniciar para contactos nuevos (`null` = no iniciar) |

---

## Flujo paso a paso

```
[Webhook POST /webhook/import-contacts]
        │
        ▼
[Code – Parse Input]
   Si source='csv': decodifica base64 → parsea CSV → array de {phone, first_name, last_name}
   Si source='api': usa contacts[] directamente
   Normaliza column names según mapping
        │
        ▼
[Postgres – Create Import Log]
   INSERT INTO import_logs (source, filename, status='running')
   RETURNING id → import_log_id
        │
        ▼
[Split In Batches: 50]
        │
        ▼
[Code – Normalize & Filter]
   Por cada contacto:
   - Limpiar phone (quitar espacios, guiones)
   - Validar formato básico: tiene dígitos, largo razonable
   - Separar válidos e inválidos
        │
        ├── inválidos → acumular en error_list
        │
        └── válidos →
                │
                ▼
        [Postgres – Upsert Contacts]
           Por cada contacto válido:
           SELECT * FROM upsert_contact(phone, first_name, last_name, NULL, source, tags)
           Acumular: inserted / updated / skipped
                │
                ▼
        [IF – trigger_sequence?]
                ├── SÍ + action='inserted' →
                │       [Postgres – Start Sequence]
                │       SELECT start_sequence(contact_id, trigger_sequence)
                │
                └── NO → continuar
        │
        ▼ (al terminar todos los batches)
[Postgres – Update Import Log]
   UPDATE import_logs SET
     status='completed', imported, updated, skipped, failed,
     invalid_phones, error_rows, completed_at, duration_ms
        │
        ▼
[Respond – Import Result (200)]
```

---

## Output exitoso

```json
{
  "import_log_id": "uuid",
  "status": "completed",
  "total_rows": 1500,
  "imported": 1234,
  "updated": 201,
  "skipped": 45,
  "failed": 20,
  "invalid_phones": 15,
  "duration_ms": 4200,
  "errors_sample": [
    { "row": 7,  "phone": "123",         "reason": "INVALID_FORMAT" },
    { "row": 44, "phone": "+54911AAAA", "reason": "INVALID_FORMAT" }
  ]
}
```

---

## Nodos n8n

| # | Nombre | Tipo | Descripción |
|---|--------|------|-------------|
| 1 | Webhook | `webhook` | Recibe POST |
| 2 | Code – Parse Input | `code` | Decodifica CSV o normaliza JSON según `source` |
| 3 | Postgres – Create Log | `postgres` | `INSERT import_logs` → retorna `import_log_id` |
| 4 | Split In Batches | `splitInBatches` | 50 contactos por lote |
| 5 | Code – Normalize & Filter | `code` | Limpia phones, separa válidos/inválidos |
| 6 | Postgres – Upsert Contacts | `postgres` | Llama `upsert_contact()` por cada válido |
| 7 | IF – Trigger Sequence | `if` | ¿Hay `trigger_sequence` y el contacto es nuevo? |
| 8 | Postgres – Start Sequence | `postgres` | `SELECT start_sequence(contact_id, sequence_name)` |
| 9 | Code – Accumulate Stats | `code` | Suma inserted/updated/skipped/failed entre batches |
| 10 | Postgres – Update Log | `postgres` | `UPDATE import_logs SET status='completed'` |
| 11 | Respond – Result | `respondToWebhook` | JSON con resultado completo |

---

## Tablas DB afectadas

| Tabla | Operación |
|-------|-----------|
| `contacts` | INSERT / UPDATE (vía función) |
| `contact_tags` | INSERT (vía función) |
| `import_logs` | INSERT + UPDATE |
| `sequence_executions` | INSERT (si trigger_sequence configurado) |

---

## Errores posibles

| Error | Causa | Acción |
|-------|-------|--------|
| `INVALID_BASE64` | `data` no es base64 válido | Respond 400 antes de crear log |
| `EMPTY_CSV` | CSV sin filas de datos | Respond 400 |
| `INVALID_PHONE_FORMAT` | Phone no normalizable | Acumular en `error_rows`, continuar |
| `DB_CONSTRAINT_ERROR` | Violación inesperada | Acumular en `failed`, continuar |
| `SEQUENCE_NOT_FOUND` | `trigger_sequence` no existe | Log warning, no bloquea el import |

---

## Formato CSV esperado

```csv
Telefono,Nombre,Apellido
+5491112345678,Juan,García
5491187654321,María,López
011-1234-5678,Pedro,Martínez
```

El parser acepta con o sin `+`, con guiones/espacios (los normaliza), con o sin código de país (asume +54 si es ambiguo — configurable).
