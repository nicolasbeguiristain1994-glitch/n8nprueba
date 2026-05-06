import { NextRequest, NextResponse } from 'next/server'
import { checkPermission } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { query } from '@/lib/db'

const EVO_URL = process.env.EVOLUTION_URL!

const INSTANCE_RE = /^[a-zA-Z0-9_-]{1,64}$/

function validInstance(name: string): boolean {
  return INSTANCE_RE.test(name)
}

// GET /api/lines/qr?instance=xxx[&restart=true]
// Intenta obtener QR de la instancia. Si no existe y hay EVOLUTION_GLOBAL_API_KEY, la crea.
// Con ?restart=true reinicia la instancia antes de pedir el QR (fuerza sesión QR nueva).
export async function GET(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'update')
  if (err) return err

  const instance = req.nextUrl.searchParams.get('instance')
  if (!instance) return NextResponse.json({ error: 'instance required' }, { status: 400 })
  if (!validInstance(instance)) return NextResponse.json({ error: 'Invalid instance name' }, { status: 400 })

  const EVO_GLOBAL = process.env.EVOLUTION_GLOBAL_API_KEY
  const EVO_KEY    = EVO_GLOBAL || process.env.EVOLUTION_API_KEY
  const forceRestart = req.nextUrl.searchParams.get('restart') === 'true'

  try {
    // Reiniciar la instancia para forzar una sesión QR completamente nueva.
    // Necesario cuando el QR anterior fue intentado usar o la instancia quedó
    // en un estado intermedio ("connecting" sin completar el handshake).
    if (forceRestart) {
      await fetch(`${EVO_URL}/instance/restart/${encodeURIComponent(instance)}`, {
        method: 'PUT',
        headers: { apikey: EVO_KEY ?? '' },
      }).catch(() => {})
      await new Promise(r => setTimeout(r, 2500))
    }

    const res = await fetch(`${EVO_URL}/instance/connect/${encodeURIComponent(instance)}`, {
      headers: { apikey: EVO_KEY ?? '' },
      cache: 'no-store',
    })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any
    try {
      data = await res.json()
    } catch {
      data = {}
    }

    // Ya está conectada — obtener el número de teléfono del ownerJid y actualizar la DB
    if (data?.instance?.state === 'open' || data?.state === 'open') {
      let phone_number: string | null = null
      try {
        const infoRes = await fetch(
          `${EVO_URL}/instance/fetchInstances?instanceName=${encodeURIComponent(instance)}`,
          { headers: { apikey: EVO_KEY ?? '' }, cache: 'no-store' },
        )
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const infoData: any = await infoRes.json()
        const ownerJid: string | undefined = infoData?.[0]?.ownerJid ?? infoData?.ownerJid
        if (ownerJid) {
          const digits = ownerJid.split('@')[0]
          if (digits) phone_number = `+${digits}`
        }
      } catch { /* phone_number queda null */ }

      // Persistir estado de conexión en la DB
      try {
        await query(
          `UPDATE whatsapp_lines
           SET is_connected = true, status = 'active', last_seen_at = NOW(), updated_at = NOW()
               ${phone_number ? ', phone_number = $2' : ''}
           WHERE evolution_instance = $1`,
          phone_number ? [instance, phone_number] : [instance],
        )
      } catch { /* no bloquear la respuesta si falla el update */ }

      // Auto-configurar webhook en Evolution para que los estados de entrega/lectura
      // lleguen a la app automáticamente sin necesidad de configuración manual.
      const webhookSecret = process.env.EVOLUTION_WEBHOOK_SECRET
      if (webhookSecret) {
        const appOrigin = new URL(req.url).origin
        fetch(`${EVO_URL}/webhook/set/${encodeURIComponent(instance)}`, {
          method:  'POST',
          headers: { apikey: EVO_KEY ?? '', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            webhook: {
              enabled:           true,
              url:               `${appOrigin}/api/webhook/evolution`,
              webhook_by_events: true,
              webhook_base64:    false,
              headers:           { 'x-webhook-secret': webhookSecret },
              events:            ['MESSAGES_UPSERT', 'MESSAGES_UPDATE'],
            },
          }),
        }).catch(() => {})
      }

      return NextResponse.json({ connected: true, phone_number })
    }

    // Instancia no existe
    if (res.status === 404 || data?.status === 404) {
      // Marcar como desconectada en DB si existe
      await query(
        `UPDATE whatsapp_lines SET is_connected = false, updated_at = NOW() WHERE evolution_instance = $1`,
        [instance],
      ).catch(() => {})
      return NextResponse.json({ connected: false, base64: null, notFound: true, canCreate: !!EVO_GLOBAL })
    }

    // Instancia existe pero desconectada → marcar en DB y devolver QR
    await query(
      `UPDATE whatsapp_lines SET is_connected = false, updated_at = NOW() WHERE evolution_instance = $1`,
      [instance],
    ).catch(() => {})
    const base64 = (data?.base64 ?? data?.qrcode?.base64 ?? null) as string | null
    return NextResponse.json({ connected: false, base64 })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

// POST /api/lines/qr  → crea la instancia usando el EVOLUTION_GLOBAL_API_KEY del servidor
export async function POST(req: NextRequest) {
  // Creates Evolution instances — admin only
  const err = await checkPermission(req, 'lines', 'manage')
  if (err) return err

  const EVO_GLOBAL = process.env.EVOLUTION_GLOBAL_API_KEY
  if (!EVO_GLOBAL) {
    return NextResponse.json({ error: 'Evolution admin key not configured' }, { status: 500 })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
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
      method: 'POST',
      headers: { apikey: EVO_GLOBAL, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instanceName: instance,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
      }),
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any
    try {
      data = await res.json()
    } catch {
      data = {}
    }

    if (res.status === 401 || data?.status === 401) {
      return NextResponse.json({ error: 'unauthorized', managerUrl: `${EVO_URL}/manager` }, { status: 401 })
    }

    // Extraer base64 del QR de la respuesta de create
    const base64 = (data?.qrcode?.base64 ?? data?.base64 ?? null) as string | null

    // Si no vino QR en create, hacer un connect para pedirlo
    if (!base64) {
      await new Promise(r => setTimeout(r, 2000)) // esperar que la instancia arranque
      const EVO_KEY = EVO_GLOBAL || process.env.EVOLUTION_API_KEY
      const qrRes = await fetch(`${EVO_URL}/instance/connect/${encodeURIComponent(instance)}`, {
        headers: { apikey: EVO_KEY ?? '' },
        cache: 'no-store',
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let qrData: any
      try {
        qrData = await qrRes.json()
      } catch {
        qrData = {}
      }
      const qrBase64 = (qrData?.base64 ?? qrData?.qrcode?.base64 ?? null) as string | null
      void audit({ req, action: 'manage', resource: 'lines',
        metadata: { instance: String(instance) } })
      return NextResponse.json({ created: true, base64: qrBase64 })
    }

    void audit({ req, action: 'manage', resource: 'lines',
      metadata: { instance: String(instance) } })
    return NextResponse.json({ created: true, base64 })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
