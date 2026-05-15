import { NextRequest, NextResponse } from 'next/server'
import { checkPermission } from '@/lib/permissions'
import { query } from '@/lib/db'
import { parseInstancesResponse } from '@/lib/evolution-utils'

const EVO_URL     = process.env.EVOLUTION_URL!
const INSTANCE_RE = /^[a-zA-Z0-9_\-. ]{1,64}$/

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
    // ── Usar connectionState para estado en tiempo real ───────────────────────
    // fetchInstances lee de caché/DB de Evolution y puede retornar 'close'
    // aunque Baileys ya esté conectado. connectionState consulta el WebSocket
    // de Baileys directamente y refleja el estado real.
    const csRes = await fetch(
      `${EVO_URL}/instance/connectionState/${encodeURIComponent(instance)}`,
      { headers: { apikey: EVO_KEY }, cache: 'no-store' },
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let csBody: any
    try { csBody = await csRes.json() } catch { csBody = {} }

    const parsed = parseInstancesResponse(csRes.status, csBody)

    console.log(JSON.stringify({
      ts: new Date().toISOString(), event: 'qr.status.polled',
      instance, state: parsed.state,
    }))

    if (csRes.status === 404 || parsed.state === 'notFound') {
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
      // Obtener phone_number vía fetchInstances (incluye ownerJid, connectionState no lo tiene)
      let phone_number: string | null = null
      try {
        const fiRes  = await fetch(
          `${EVO_URL}/instance/fetchInstances?instanceName=${encodeURIComponent(instance)}`,
          { headers: { apikey: EVO_KEY }, cache: 'no-store' },
        )
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let fiBody: any
        try { fiBody = await fiRes.json() } catch { fiBody = [] }
        phone_number = parseInstancesResponse(fiRes.status, fiBody).phone_number
      } catch { /* best-effort */ }

      await query(
        `UPDATE whatsapp_lines
         SET is_connected = true, status = 'active', last_seen_at = NOW(), updated_at = NOW()
             ${phone_number ? ', phone_number = $2' : ''}
         WHERE evolution_instance = $1`,
        phone_number ? [instance, phone_number] : [instance],
      ).catch(e => console.error('[qr/status] db update error:', e?.message))

      return NextResponse.json({
        state:        'open',
        connected:    true,
        phone_number,
      })
    }

    // connecting o close — no tocar DB
    return NextResponse.json({ state: parsed.state, connected: false })
  } catch (e) {
    console.error('[qr/status] error:', e)
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
