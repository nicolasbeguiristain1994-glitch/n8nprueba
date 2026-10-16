// Raise this only in a release that supports the corresponding database model.
export const CONTACT_SCHEMA_VERSION = 1
const CACHE_MS = 2000
let checkedAt = 0
let requiredVersion = 1
let reading: Promise<number> | undefined

export async function deploymentSchemaReady(): Promise<boolean> {
  if (process.env.NODE_ENV !== 'production' || !(process.env.DATABASE_URL || process.env.DB_HOST)) return true
  try {
    if (Date.now() - checkedAt >= CACHE_MS) {
      reading ??= import('./db').then(async ({ query }) => {
        const rows = await query<{value:unknown}>("SELECT value FROM app_settings WHERE key='contact_schema_required_version'")
        const value = rows[0]?.value ?? 1
        if (!Number.isInteger(value) || Number(value) < 1) throw Error('Invalid schema version')
        requiredVersion = Number(value)
        checkedAt = Date.now()
        return requiredVersion
      }).finally(() => { reading = undefined })
      await reading
    }
    return requiredVersion <= CONTACT_SCHEMA_VERSION
  } catch {
    // Do not accept a webhook/cron write when compatibility cannot be checked.
    return false
  }
}
