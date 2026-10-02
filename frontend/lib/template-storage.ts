/**
 * Server only. Compatibilidad de escritura con las dos variantes de whatsapp_templates:
 *
 *  - Histórica (db/schema/init.sql + migraciones 039/131): tiene `domain` y `body`
 *    NOT NULL sin default, así que todo INSERT debe completarlas.
 *  - Moderna (solo migración 039): no tiene esas columnas.
 *
 * Se detectan por catálogo en cada operación (sin cache: el cliente/base puede variar)
 * y solo se agregan fragmentos SQL fijos de esta lista; nunca identificadores dinámicos.
 */

export type RowsQuery = (sql: string, params?: unknown[]) => Promise<unknown[]>
export type LegacyTemplateColumns = { domain: boolean; body: boolean }

/** Dominio neutro para filas nuevas en la tabla histórica; las existentes conservan el suyo. */
export const LEGACY_TEMPLATE_DOMAIN = 'general'

const LEGACY_COLUMNS_SQL = `SELECT
  EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
          WHERE attrelid = to_regclass('whatsapp_templates') AND attname = 'domain'
            AND attnum > 0 AND NOT attisdropped) AS domain,
  EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
          WHERE attrelid = to_regclass('whatsapp_templates') AND attname = 'body'
            AND attnum > 0 AND NOT attisdropped) AS body`

export async function detectLegacyTemplateColumns(run: RowsQuery): Promise<LegacyTemplateColumns> {
  const [row] = await run(LEGACY_COLUMNS_SQL) as Array<Partial<LegacyTemplateColumns> | undefined>
  return { domain: row?.domain === true, body: row?.body === true }
}

/** Texto del primer componente BODY ('' si no hay; la columna histórica no admite NULL). */
export function templateBodyText(components: unknown): string {
  if (!Array.isArray(components)) return ''
  const body = components.find(c => (c as { type?: unknown })?.type === 'BODY') as { text?: unknown } | undefined
  return typeof body?.text === 'string' ? body.text : ''
}

/** Columnas/valores extra para un INSERT según la variante detectada. */
function legacyInsertColumns(cols: LegacyTemplateColumns, components: unknown) {
  const names: string[] = []
  const values: unknown[] = []
  if (cols.domain) { names.push('domain'); values.push(LEGACY_TEMPLATE_DOMAIN) }
  if (cols.body)   { names.push('body');   values.push(templateBodyText(components)) }
  return { names, values }
}

const placeholders = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => `$${from + i}`)

export function buildLocalTemplateInsert(cols: LegacyTemplateColumns, input: {
  name: string; category: string; language: string; components: unknown[]; createdBy: string | null
}): { sql: string; values: unknown[] } {
  const extra = legacyInsertColumns(cols, input.components)
  const columns = ['name', 'category', 'language', 'components', 'created_by', ...extra.names]
  const binds = ['$1', '$2', '$3', '$4::jsonb', '$5', ...placeholders(6, extra.values.length)]
  return {
    sql: `INSERT INTO whatsapp_templates (${columns.join(', ')})
       VALUES (${binds.join(', ')})
       RETURNING id`,
    values: [input.name, input.category, input.language, JSON.stringify(input.components), input.createdBy, ...extra.values],
  }
}

/** SET adicional para PATCH con componentes: refleja BODY en la columna histórica; `domain` no se toca. */
export function legacyBodyUpdate(cols: LegacyTemplateColumns, components: unknown[]): { column: 'body'; value: string } | null {
  return cols.body ? { column: 'body', value: templateBodyText(components) } : null
}

export type CatalogueTemplate = {
  id: string; name: string; category: string; language: string; status: string
  components: unknown[]; rejected_reason?: string | null
}

/**
 * Upsert de un catálogo importado. Parámetros $1..$9 fijos; domain/body se agregan
 * al final. En conflicto se actualiza body pero se conserva el domain existente.
 */
export function buildCatalogueUpsert(cols: LegacyTemplateColumns) {
  const extraNames = [cols.domain && 'domain', cols.body && 'body'].filter((c): c is string => !!c)
  const columns = ['name', 'category', 'language', 'status', 'components', 'whatsapp_template_id', 'waba_id', 'created_by', 'rejection_reason', ...extraNames]
  const binds = ['$1', '$2', '$3', '$4', '$5::jsonb', '$6', '$7', '$8', '$9', ...placeholders(10, extraNames.length)]
  const sql = `INSERT INTO whatsapp_templates
            (${columns.join(',')})
            VALUES (${binds.join(',')})
            ON CONFLICT (waba_id,name,language) WHERE waba_id IS NOT NULL DO UPDATE SET
              category=EXCLUDED.category,status=EXCLUDED.status,components=EXCLUDED.components,
              whatsapp_template_id=EXCLUDED.whatsapp_template_id,rejection_reason=EXCLUDED.rejection_reason,${cols.body ? 'body=EXCLUDED.body,' : ''}updated_at=NOW()`
  const values = (t: CatalogueTemplate, status: string, wabaId: string, userId: string | null) => [
    t.name, t.category, t.language, status, JSON.stringify(t.components), t.id, wabaId, userId, t.rejected_reason ?? null,
    ...legacyInsertColumns(cols, t.components).values,
  ]
  return { sql, values }
}
