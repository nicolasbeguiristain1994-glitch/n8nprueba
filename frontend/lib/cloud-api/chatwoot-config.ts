// Chatwoot es una integración externa opcional. Este helper sólo informa si la
// configuración está completa; nunca devuelve sus valores.

const CHATWOOT_ENV_VARS = ['CHATWOOT_API_URL', 'CHATWOOT_API_KEY', 'CHATWOOT_ACCOUNT_ID'] as const

export function isChatwootConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return CHATWOOT_ENV_VARS.every(name => (env[name] ?? '').trim() !== '')
}
