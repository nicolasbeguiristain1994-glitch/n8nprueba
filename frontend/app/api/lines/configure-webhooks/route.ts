import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'

/**
 * POST /api/lines/configure-webhooks
 *
 * Re-configura webhook + readStatus en todas las líneas activas de Evolution.
 * Necesario para que Evolution mande MESSAGES_UPDATE (delivery/read receipts).
 *
 * Sin readStatus=true, Evolution recibe los ACKs de WhatsApp pero no los
 * reenvía al webhook → Entregados y Leídos siempre muestran 0.
 *
 * Idempotente: seguro ejecutar múltiples veces.
 */
export async function POST(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'update')
  if (err) return err

  const evoUrl    = process.env.EVOLUTION_URL || ''
  const apiKey    = process.env.EVOLUTION_GLOBAL_API_KEY || process.env.EVOLUTION_API_KEY || ''
  const secret    = process.env.EVOLUTION_WEBHOOK_SECRET || ''
  const appOrigin = new URL(req.url).origin

  if (!evoUrl || !apiKey || !secret) {
    return NextResponse.json({ error: 'Evolution not configured (EVOLUTION_URL, key, EVOLUTION_WEBHOOK_SECRET required)' }, { status: 500 })
  }

  const lines = await query<{ evolution_instance: string; evolution_url: string | null }>(
    `SELECT evolution_instance, evolution_url
     FROM whatsapp_lines
     WHERE status = 'active'`,
  ).catch(() => [])

  if (lines.length === 0) return NextResponse.json({ configured: 0, errors: [] })

  const results: { instance: string; ok: boolean; error?: string }[] = []

  for (const line of lines) {
    const lineEvoUrl = line.evolution_url || evoUrl
    const instance   = line.evolution_instance

    try {
      // 1. Webhook: URL + events
      const webhookRes = await fetch(
        `${lineEvoUrl}/webhook/set/${encodeURIComponent(instance)}`,
        {
          method:  'POST',
          headers: { apikey: apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            webhook: {
              enabled:           true,
              url:               `${appOrigin}/api/webhook/evolution`,
              webhookByEvents:   false,
              webhook_by_events: false,
              webhookBase64:     false,
              webhook_base64:    false,
              headers:           { 'x-webhook-secret': secret },
              events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE'],
            },
          }),
          signal: AbortSignal.timeout(8000),
        },
      )

      // 2. Settings: readStatus=true so Evolution fires MESSAGES_UPDATE for ACKs
      const settingsRes = await fetch(
        `${lineEvoUrl}/settings/set/${encodeURIComponent(instance)}`,
        {
          method:  'POST',
          headers: { apikey: apiKey, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ readStatus: true }),
          signal:  AbortSignal.timeout(8000),
        },
      )

      if (!webhookRes.ok || !settingsRes.ok) {
        results.push({ instance, ok: false, error: `webhook=${webhookRes.status} settings=${settingsRes.status}` })
      } else {
        results.push({ instance, ok: true })
      }
    } catch (e) {
      results.push({ instance, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  const configured = results.filter(r => r.ok).length
  const errors     = results.filter(r => !r.ok)

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    event: 'configure-webhooks.done',
    total: lines.length,
    configured,
    errors: errors.length,
  }))

  return NextResponse.json({ configured, total: lines.length, errors })
}
