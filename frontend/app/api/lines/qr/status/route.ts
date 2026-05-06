import { NextRequest, NextResponse } from 'next/server'
import { checkPermission } from '@/lib/permissions'
import { query } from '@/lib/db'

const EVO_URL     = process.env.EVOLUTION_URL!
const INSTANCE_RE = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * GET /api/lines/qr/status?instance=xxx
 *
 * Consulta el estado de conexión de una instancia SIN regenerar el QR.
 * Usa GET /instance/fetchInstances — endpoint read-only, seguro para polling.
 *
 * NO usar GET /instance/connect para polling: ese endpoint genera/rota el QR
 * en Evolution, lo que invalida cualquier pairing en curso y causa el error
 * "No se pudo vincular el dispositivo" cuando el teléfono escanea.
 *
 * Estados posibles:
 *   close      → esperando escaneo
 *   connecting → QR escaneado, handshake en progreso (NO interrumpir)
 *   open       → conectado
 */
export async function GET(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'update')
  if (err) return err

  const instance = req.nextUrl.searchParams.get('instance')
  if (!instance || !INSTANCE_RE.test(instance)) {
    return NextResponse.json({ error: 'instance required' }, { status: 400 })
  }

  const EVO_GLOBAL = process.env.EVOLUTION_GLOBAL_API_KEY
  const EVO_KEY    = EVO_GLOBAL || process.env.EVOLUTION_API_KEY

  try {
    const res = await fetch(
      `${EVO_URL}/instance/fetchInstances?instanceName=${encodeURIComponent(instance)}`,
      { headers: { apikey: EVO_KEY ?? '' }, cache: 'no-store' },
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any
    try { data = await res.json() } catch { data = [] }

    // Evolution v2 devuelve array; algunos builds devuelven objeto directo
    const inst  = Array.isArray(data) ? data[0] : data
    // El campo estado puede estar en varias posiciones según la versión
    const state: string =
      inst?.instance?.state  ??
      inst?.instance?.status ??
      inst?.state            ??
      inst?.status           ??
      'close'

    console.log('[qr/status]', instance, '→', state)

    if (state === 'open') {
      // Extraer número del ownerJid y persistir en DB
      let phone_number: string | null = null
      const ownerJid: string | undefined =
        inst?.ownerJid ?? inst?.instance?.ownerJid ?? inst?.profilePictureUrl
      if (ownerJid && typeof ownerJid === 'string' && ownerJid.includes('@')) {
        const digits = ownerJid.split('@')[0]
        if (digits) phone_number = `+${digits}`
      }

      await query(
        `UPDATE whatsapp_lines
         SET is_connected = true, status = 'active', last_seen_at = NOW(), updated_at = NOW()
             ${phone_number ? ', phone_number = $2' : ''}
         WHERE evolution_instance = $1`,
        phone_number ? [instance, phone_number] : [instance],
      ).catch(e => console.error('[qr/status] db update error:', e?.message))

      return NextResponse.json({ state: 'open', connected: true, phone_number })
    }

    // connecting o close — no tocar nada en DB
    return NextResponse.json({ state, connected: false })
  } catch (e) {
    console.error('[qr/status] error:', e)
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
