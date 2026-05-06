import { NextRequest, NextResponse } from 'next/server'
import { checkPermission } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { query } from '@/lib/db'

const EVO_URL = process.env.EVOLUTION_URL!

const INSTANCE_RE = /^[a-zA-Z0-9_-]{1,64}$/

function validInstance(name: string): boolean {
  return INSTANCE_RE.test(name)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractBase64(data: any): string | null {
  return (
    data?.base64 ??
    data?.qrcode?.base64 ??
    data?.qr?.base64 ??
    data?.code ??          // algunas versiones de Evolution devuelven 'code'
    null
  ) as string | null
}

// GET /api/lines/qr?instance=xxx[&restart=true]
// Con ?restart=true hace POST /instance/restart antes de pedir el QR
// para forzar una sesión nueva (útil si el QR anterior quedó inválido).
export async function GET(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'update')
  if (err) return err

  const instance = req.nextUrl.searchParams.get('instance')
  if (!instance) return NextResponse.json({ error: 'instance required' }, { status: 400 })
  if (!validInstance(instance)) return NextResponse.json({ error: 'Invalid instance name' }, { status: 400 })

  const EVO_GLOBAL   = process.env.EVOLUTION_GLOBAL_API_KEY
  const EVO_KEY      = EVO_GLOBAL || process.env.EVOLUTION_API_KEY
  const forceRestart = req.nextUrl.searchParams.get('restart') === 'true'

  try {
    if (forceRestart) {
      const restartRes = await fetch(
        `${EVO_URL}/instance/restart/${encodeURIComponent(instance)}`,
        { method: 'POST', headers: { apikey: EVO_KEY ?? '' } },
      ).catch(e => { console.warn('[qr/restart] fetch error:', e?.message); return null })

      console.log('[qr/restart] status:', restartRes?.status)
      await new Promise(r => setTimeout(r, 3000))
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

    // Log completo para diagnóstico — visible en Railway logs
    console.log('[qr/connect] instance:', instance, '| status:', res.status, '| data:', JSON.stringify(data))

    // Ya conectada
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

      try {
        await query(
          `UPDATE whatsapp_lines
           SET is_connected = true, status = 'active', last_seen_at = NOW(), updated_at = NOW()
               ${phone_number ? ', phone_number = $2' : ''}
           WHERE evolution_instance = $1`,
          phone_number ? [instance, phone_number] : [instance],
        )
      } catch { /* no bloquear */ }

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
      await query(
        `UPDATE whatsapp_lines SET is_connected = false, updated_at = NOW() WHERE evolution_instance = $1`,
        [instance],
      ).catch(() => {})
      return NextResponse.json({ connected: false, base64: null, notFound: true, canCreate: !!EVO_GLOBAL })
    }

    // Desconectada → devolver QR
    await query(
      `UPDATE whatsapp_lines SET is_connected = false, updated_at = NOW() WHERE evolution_instance = $1`,
      [instance],
    ).catch(() => {})

    const base64 = extractBase64(data)

    if (!base64) {
      // Log extra si no encontramos el QR para saber por qué
      console.warn('[qr/connect] no base64 found — full response:', JSON.stringify(data))
    }

    return NextResponse.json({ connected: false, base64, _state: data?.instance?.state ?? data?.state ?? null })
  } catch (e) {
    console.error('[qr/connect] unexpected error:', e)
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

// POST /api/lines/qr  → crea la instancia usando el EVOLUTION_GLOBAL_API_KEY del servidor
export async function POST(req: NextRequest) {
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

    console.log('[qr/create] instance:', instance, '| status:', res.status, '| data:', JSON.stringify(data))

    if (res.status === 401 || data?.status === 401) {
      return NextResponse.json({ error: 'unauthorized', managerUrl: `${EVO_URL}/manager` }, { status: 401 })
    }

    const base64 = extractBase64(data)

    if (!base64) {
      await new Promise(r => setTimeout(r, 2000))
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
      console.log('[qr/create→connect] status:', qrRes.status, '| data:', JSON.stringify(qrData))
      const qrBase64 = extractBase64(qrData)
      void audit({ req, action: 'manage', resource: 'lines', metadata: { instance: String(instance) } })
      return NextResponse.json({ created: true, base64: qrBase64 })
    }

    void audit({ req, action: 'manage', resource: 'lines', metadata: { instance: String(instance) } })
    return NextResponse.json({ created: true, base64 })
  } catch (e) {
    console.error('[qr/create] unexpected error:', e)
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
