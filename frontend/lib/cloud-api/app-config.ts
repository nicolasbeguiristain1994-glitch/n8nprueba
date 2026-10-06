import { z } from 'zod'
import { CloudApiError } from './errors'

const metaId = z.string().regex(/^\d{5,30}$/)
const credential = z.string().min(16).max(4096).refine(v => !v.startsWith('replace-'))
const additionalAppsSchema = z.array(z.object({
  appId: metaId,
  name: z.string().trim().min(1).max(100),
  appSecret: credential,
  verifyToken: credential,
  wabaIds: z.array(metaId).min(1).max(100),
}).strict()).max(100)

export type MetaAppConfig = {
  appId: string
  name: string
  appSecret: string
  verifyToken: string
  wabaIds: string[]
  legacy: boolean
  webhookPath: string
  permitsWaba: (wabaId: string) => boolean
}

// This server-only registry assigns each additional WABA to exactly one app.
// Never expose its raw value or validation errors: both contain credentials.
export function metaApps(): MetaAppConfig[] {
  let additional: z.infer<typeof additionalAppsSchema>
  try {
    const raw = process.env.META_ADDITIONAL_APPS_JSON
    additional = additionalAppsSchema.parse(raw?.trim() ? JSON.parse(raw) : [])
    const ids = new Set([process.env.META_APP_ID || ''])
    const wabas = new Set<string>()
    const secrets = new Set([process.env.META_APP_SECRET || ''])
    const verifiers = new Set([process.env.META_WEBHOOK_VERIFY_TOKEN || ''])
    for (const app of additional) {
      if (ids.has(app.appId) || secrets.has(app.appSecret) || verifiers.has(app.verifyToken)) throw new Error()
      ids.add(app.appId); secrets.add(app.appSecret); verifiers.add(app.verifyToken)
      for (const wabaId of app.wabaIds) {
        if (wabas.has(wabaId)) throw new Error()
        wabas.add(wabaId)
      }
    }
  } catch {
    throw new CloudApiError('Revisá la configuración de aplicaciones Meta adicionales en el servidor.')
  }
  const reserved = new Set(additional.flatMap(app => app.wabaIds))
  return [{
    appId: process.env.META_APP_ID || '',
    name: 'Aplicación principal',
    appSecret: process.env.META_APP_SECRET || '',
    verifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || '',
    wabaIds: [], legacy: true, webhookPath: '/api/cloud/webhook',
    permitsWaba: (wabaId: string) => !reserved.has(wabaId),
  }, ...additional.map(app => ({
    ...app, legacy: false, webhookPath: `/api/cloud/webhook/${app.appId}`,
    permitsWaba: (wabaId: string) => app.wabaIds.includes(wabaId),
  }))]
}

export function metaApp(appId?: string): MetaAppConfig | undefined {
  const apps = metaApps()
  return appId === undefined ? apps[0] : apps.find(app => app.appId === appId)
}

export function appChecks(app: MetaAppConfig) {
  return {
    appId: metaId.safeParse(app.appId).success,
    appSecret: !!app.appSecret && !app.appSecret.startsWith('replace-'),
    verifyToken: !!app.verifyToken && !app.verifyToken.startsWith('replace-'),
    encryptionKey: (process.env.TOKEN_ENCRYPTION_KEY?.length ?? 0) >= 32 && !process.env.TOKEN_ENCRYPTION_KEY?.startsWith('replace-'),
  }
}

export function publicAppConfiguration(app: MetaAppConfig) {
  return { appId: app.appId, name: app.name, wabaIds: app.wabaIds, webhookPath: app.webhookPath, checks: appChecks(app) }
}
