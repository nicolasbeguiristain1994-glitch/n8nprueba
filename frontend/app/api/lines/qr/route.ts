import { NextRequest, NextResponse } from 'next/server'

const EVO_URL    = process.env.EVOLUTION_URL!
const EVO_GLOBAL = process.env.EVOLUTION_GLOBAL_API_KEY     // admin key (crear + conectar instancias)
const EVO_KEY    = EVO_GLOBAL || process.env.EVOLUTION_API_KEY!  // usar global si está disponible

// GET /api/lines/qr?instance=xxx
// Intenta obtener QR de la instancia. Si no existe y hay EVOLUTION_GLOBAL_API_KEY, la crea.
export async function GET(req: NextRequest) {
  const instance = req.nextUrl.searchParams.get('instance')
  if (!instance) return NextResponse.json({ error: 'instance required' }, { status: 400 })

  try {
    const res = await fetch(`${EVO_URL}/instance/connect/${instance}`, {
      headers: { apikey: EVO_KEY },
      cache: 'no-store',
    })
    const data = await res.json()

    // Ya está conectada
    if (data?.instance?.state === 'open' || data?.state === 'open') {
      return NextResponse.json({ connected: true })
    }

    // Instancia no existe
    if (res.status === 404 || data?.status === 404) {
      return NextResponse.json({ connected: false, base64: null, notFound: true, canCreate: !!EVO_GLOBAL })
    }

    // Instancia existe pero desconectada → devuelve QR
    const base64 = data?.base64 ?? data?.qrcode?.base64 ?? null
    return NextResponse.json({ connected: false, base64 })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

// POST /api/lines/qr  → crea la instancia usando el EVOLUTION_GLOBAL_API_KEY
export async function POST(req: NextRequest) {
  const { instance, globalKey } = await req.json()
  if (!instance) return NextResponse.json({ error: 'instance required' }, { status: 400 })

  // Usar el key proporcionado en la request o el del env
  const key = globalKey || EVO_GLOBAL || EVO_KEY

  try {
    const res = await fetch(`${EVO_URL}/instance/create`, {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instanceName: instance,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
      }),
    })
    const data = await res.json()

    if (res.status === 401 || data?.status === 401) {
      return NextResponse.json({ error: 'unauthorized', managerUrl: `${EVO_URL}/manager` }, { status: 401 })
    }

    // Extraer base64 del QR de la respuesta de create
    const base64 = data?.qrcode?.base64 ?? data?.base64 ?? null

    // Si no vino QR en create, hacer un connect para pedirlo
    if (!base64) {
      await new Promise(r => setTimeout(r, 2000)) // esperar que la instancia arranque
      const qrRes = await fetch(`${EVO_URL}/instance/connect/${instance}`, {
        headers: { apikey: EVO_KEY },
        cache: 'no-store',
      })
      const qrData = await qrRes.json()
      const qrBase64 = qrData?.base64 ?? qrData?.qrcode?.base64 ?? null
      return NextResponse.json({ created: true, base64: qrBase64 })
    }

    return NextResponse.json({ created: true, base64 })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
