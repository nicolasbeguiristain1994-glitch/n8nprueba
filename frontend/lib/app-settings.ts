import { query } from '@/lib/db'

/**
 * Lee un setting del sistema desde app_settings.
 * Retorna el valor parseado, o `fallback` si no existe o falla.
 * Uso: await getAppSetting<boolean>('perms_contacts_export_global', true)
 */
export async function getAppSetting<T = unknown>(key: string, fallback: T): Promise<T> {
  try {
    const rows = await query<{ value: T }>(
      'SELECT value FROM app_settings WHERE key = $1',
      [key]
    )
    if (!rows[0]) return fallback
    return rows[0].value as T
  } catch {
    return fallback
  }
}
