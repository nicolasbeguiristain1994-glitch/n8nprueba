import { NextRequest, NextResponse } from 'next/server'
import { checkPermission } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { query } from '@/lib/db'

const EVO_URL     = process.env.EVOLUTION_URL!
const INSTANCE_RE = /^[a-zA-Z0-9_-]{1,64}$/

function validInstance(name: string): boolean {
  return INSTANCE_RE.test(name)
}

/**
 * Extrae el QR base64 de la respuesta de Evolution.
 * Evolution v2 puede devolver el base64 en varias ubicaciones.
 * IMPORTANTE: no incluir 'code' aquí — ese campo puede ser un pairing code
 * de texto plano, no un PNG en base64.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractBase64(data: any): string | null {
  return (
    data?.base64        ??
    data?.qrcode?.base64 ??
    data?.qr?.base64    ??
    null
  ) as string | null
}

/**
 * Configura el webhook en Evolution para esta instancia.
 * Se llama una vez que la instancia está conectada (state = open).
 *
 * Payload para Evolution v2 — usa snake_case en el nivel interior del objeto
 * webhook (webhookByEvents / webhook_by_events varían por versión; enviamos
 * ambas formas para máxima compatibilidad).
 */
async function setupWebhook(
  evoUrl:    string,
  evoKey:    string,
  instance:  string,
  appOrigin: string,
  secret:    string,
): Promise<void> {
  await fetch(`${evoUrl}/webhook/set/${encodeURIComponent(instance)}`, {
    method:  'POST',
    headers: { apikey: evoKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      webhook: {
        enabled:          true,
        url:              `${appOrigin}/api/webhook/evolution`,
        webhookByEvents:  false,   // Evolution v2 recibe todo en una sola URL
        webhook_by_events: false,  // compatibilidad con versiones antiguas
        webhookBase64:    false,
        webhook_base64:   false,
        headers:          { 'x-webhook-secret': secret },
        events:           [
          'MESSAGES_UPSERT',
          'MESSAGES_UPDATE',
          'CONNECTION_UPDATE',     // para detectar desconexiones automáticas
        ],
      },
    }),
  }).catch(e => console.warn('[qr/webhook] setup failed:', e?.message))
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/lines/qr?instance=xxx[&restart=true]
//
// Genera / obtiene el QR de la instancia.
// Llamar SOLO para obtener un QR nuevo — no usar para polling de estado.
// Para polling usar GET /api/lines/qr/status (usa fetchInstances, read-only).
//
// Con ?restart=true: hace POST /instance/restart antes de pedir el QR,
// forzando una sesión completamente nueva.
// ─────────────────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'update')
  if (err) return err

  const instance = req.nextUrl.searchParams.get('instance')
  if (!instance) return NextResponse.json({ error: 'instance required' }, { status: 400 })
  if (!validInstance(instance)) return NextResponse.json({ error: 'Invalid instance name' }, { status: 400 })

  const EVO_GLOBAL   = process.env.EVOLUTION_GLOBAL_API_KEY
  const EVO_KEY      = EVO_GLOBAL ?? process.env.EVOLUTION_API_KEY ?? ''
  const forceRestart = req.nextUrl.searchParams.get('restart') === 'true'

  try {
    if (forceRestart) {
      const restartRes = await fetch(
        `${EVO_URL}/instance/restart/${encodeURIComponent(instance)}`,
        { method: 'POST', headers: { apikey: EVO_KEY } },
      ).catch(e => { console.warn('[qr/restart] fetch error:', e?.message); return null })
      console.log('[qr/restart] status:', restartRes?.status ?? 'error')
      // Esperar que la instancia reinicie antes de pedir el QR
      await new Promise(r => setTimeout(r, 3000))
    }

    const res = await fetch(`${EVO_URL}/instance/connect/${encodeURIComponent(instance)}`, {
      headers: { apikey: EVO_KEY },
      cache:   'no-store',
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any
    try { data = await res.json() } catch { data = {} }

    console.log('[qr/connect] instance:', instance, '| http:', res.status, '| state:', data?.instance?.state ?? data?.state ?? '?', '| hasBase64:', !!extractBase64(data))

    // Instancia ya conectada
    if (data?.instance?.state === 'open' || data?.state === 'open') {
      let phone_number: string | null = null
      try {
        const infoRes = await fetch(
          `${EVO_URL}/instance/fetchInstances?instanceName=${encodeURIComponent(instance)}`,
          { headers: { apikey: EVO_KEY }, cache: 'no-store' },
        )
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const infoData: any = await infoRes.json()
        const inst = Array.isArray(infoData) ? infoData[0] : infoData
        const ownerJid: string | undefined = inst?.ownerJid ?? inst?.instance?.ownerJid
        if (ownerJid && ownerJid.includes('@')) {
          const digits = ownerJid.split('@')[0]
          if (digits) phone_number = `+${digits}`
        }
      } catch { /* phone_number queda null */ }

      await query(
        `UPDATE whatsapp_lines
         SET is_connected = true, status = 'active', last_seen_at = NOW(), updated_at = NOW()
             ${phone_number ? ', phone_number = $2' : ''}
         WHERE evolution_instance = $1`,
        phone_number ? [instance, phone_number] : [instance],
      ).catch(() => {})

      const webhookSecret = process.env.EVOLUTION_WEBHOOK_SECRET
      if (webhookSecret) {
        const appOrigin = new URL(req.url).origin
        void setupWebhook(EVO_URL, EVO_KEY, instance, appOrigin, webhookSecret)
      }

      return NextResponse.json({ connected: true, phone_number })
    }

    // Instancia no existe
    if (res.status === 404 || data?.status === 404) {
      await query(
        `UPDATE whatsapp_lines SET is_connected = false, updated_at = NOW() WHERE evolution_instance = $1`,
        [instance],
      ).catch(() => {})
      return NextResponse.json({
        connected: false,
        base64:    null,
        notFound:  true,
        canCreate: !!(EVO_GLOBAL),
      })
    }

    // Desconectada → marcar en DB y devolver QR
    await query(
      `UPDATE whatsapp_lines SET is_connected = false, updated_at = NOW() WHERE evolution_instance = $1`,
      [instance],
    ).catch(() => {})

    const base64 = extractBase64(data)

    if (!base64) {
      console.warn('[qr/connect] no base64 found | data keys:', Object.keys(data ?? {}))
    }

    return NextResponse.json({ connected: false, base64 })
  } catch (e) {
    console.error('[qr/connect] unexpected error:', e)
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/lines/qr — crea la instancia con EVOLUTION_GLOBAL_API_KEY
// ─────────────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'manage')
  if (err) return err

  const EVO_GLOBAL = process.env.EVOLUTION_GLOBAL_API_KEY
  if (!EVO_GLOBAL) {
    return NextResponse.json({ error: 'Evolution admin key not configured' }, { status: 500 })
  }

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const instance = body.instance
  if (typeof instance !== 'string' || !instance) {
    return NextResponse.json({ error: 'instance required' }, { status: 400 })
  }
  if (!validInstance(instance)) {
    return NextResponse.json({ error: 'Invalid instance name' }, { status: 400 })
  }

  try {
    const res = await fetch(`${EVO_URL}/instance/create`, {
      method:  'POST',
      headers: { apikey: EVO_GLOBAL, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        instanceName: instance,
        qrcode:       true,
        integration:  'WHATSAPP-BAILEYS',
      }),
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any
    try { data = await res.json() } catch { data = {} }

    console.log('[qr/create] instance:', instance, '| http:', res.status, '| hasBase64:', !!extractBase64(data))

    if (res.status === 401 || data?.status === 401) {
      return NextResponse.json({ error: 'unauthorized', managerUrl: `${EVO_URL}/manager` }, { status: 401 })
    }

    const base64 = extractBase64(data)

    if (!base64) {
      // La instancia fue creada pero el QR no vino en la respuesta —
      // hacer un segundo intento con /connect después de que arranque
      await new Promise(r => setTimeout(r, 2500))
      const EVO_KEY = EVO_GLOBAL ?? process.env.EVOLUTION_API_KEY ?? ''
      const qrRes = await fetch(`${EVO_URL}/instance/connect/${encodeURIComponent(instance)}`, {
        headers: { apikey: EVO_KEY },
        cache:   'no-store',
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let qrData: any
      try { qrData = await qrRes.json() } catch { qrData = {} }
      console.log('[qr/create→connect] http:', qrRes.status, '| hasBase64:', !!extractBase64(qrData))

      void audit({ req, action: 'manage', resource: 'lines', metadata: { instance: String(instance) } })
      return NextResponse.json({ created: true, base64: extractBase64(qrData) })
    }

    void audit({ req, action: 'manage', resource: 'lines', metadata: { instance: String(instance) } })
    return NextResponse.json({ created: true, base64 })
  } catch (e) {
    console.error('[qr/create] unexpected error:', e)
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
