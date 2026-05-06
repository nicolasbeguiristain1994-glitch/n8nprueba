import { NextRequest, NextResponse } from 'next/server'
import { checkPermission } from '@/lib/permissions'
import { query } from '@/lib/db'
import { parseInstancesResponse } from '@/lib/evolution-utils'

const EVO_URL     = process.env.EVOLUTION_URL!
const INSTANCE_RE = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * GET /api/lines/qr/status?instance=xxx
 *
 * Consulta el estado de conexión de una instancia SIN regenerar el QR.
 * Usa GET /instance/fetchInstances — endpoint read-only, seguro para polling.
 *
 * NO llamar GET /instance/connect para polling: en Evolution v2 ese endpoint
 * genera/rota el QR, invalidando cualquier pairing en curso → "No se pudo
 * vincular el dispositivo".
 *
 * Respuesta:
 *   { state: 'open',       connected: true,  phone_number }
 *   { state: 'connecting', connected: false }
 *   { state: 'close',      connected: false }
 *   { state: 'notFound',   connected: false, notFound: true, canCreate: bool }
 */
export async function GET(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'update')
  if (err) return err

  const instance = req.nextUrl.searchParams.get('instance')
  if (!instance || !INSTANCE_RE.test(instance)) {
    return NextResponse.json({ error: 'instance required' }, { status: 400 })
  }

  const EVO_GLOBAL = process.env.EVOLUTION_GLOBAL_API_KEY
  const EVO_KEY    = EVO_GLOBAL ?? process.env.EVOLUTION_API_KEY ?? ''

  try {
    const res = await fetch(
      `${EVO_URL}/instance/fetchInstances?instanceName=${encodeURIComponent(instance)}`,
      { headers: { apikey: EVO_KEY }, cache: 'no-store' },
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let body: any
    try { body = await res.json() } catch { body = [] }

    const parsed = parseInstancesResponse(res.status, body)

    console.log('[qr/status]', instance, '→', parsed.state)

    if (parsed.state === 'notFound') {
      await query(
        `UPDATE whatsapp_lines SET is_connected = false, updated_at = NOW() WHERE evolution_instance = $1`,
        [instance],
      ).catch(() => {})
      return NextResponse.json({
        state:     'notFound',
        connected: false,
        notFound:  true,
        canCreate: !!EVO_GLOBAL,
      })
    }

    if (parsed.state === 'open') {
      await query(
        `UPDATE whatsapp_lines
         SET is_connected = true, status = 'active', last_seen_at = NOW(), updated_at = NOW()
             ${parsed.phone_number ? ', phone_number = $2' : ''}
         WHERE evolution_instance = $1`,
        parsed.phone_number ? [instance, parsed.phone_number] : [instance],
      ).catch(e => console.error('[qr/status] db update error:', e?.message))

      return NextResponse.json({
        state:        'open',
        connected:    true,
        phone_number: parsed.phone_number,
      })
    }

    // connecting o close — no tocar DB
    return NextResponse.json({ state: parsed.state, connected: false })
  } catch (e) {
    console.error('[qr/status] error:', e)
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
