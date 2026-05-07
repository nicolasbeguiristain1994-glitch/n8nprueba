import { NextRequest, NextResponse } from 'next/server'
import { checkPermission, checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { query } from '@/lib/db'
import { parseInstancesResponse } from '@/lib/evolution-utils'

const EVO_URL     = process.env.EVOLUTION_URL!
const INSTANCE_RE = /^[a-zA-Z0-9_-]{1,64}$/

function validInstance(name: string): boolean {
  return INSTANCE_RE.test(name)
}

/**
 * Extrae el QR base64 de la respuesta de Evolution.
 * IMPORTANTE: no incluir el campo 'code' — puede ser un pairing code de texto
 * plano, no un PNG en base64. Renderizarlo como <img src> da imagen rota.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractBase64(data: any): string | null {
  return (
    data?.base64         ??
    data?.qrcode?.base64 ??
    data?.qr?.base64     ??
    null
  ) as string | null
}

/**
 * Configura el webhook de Evolution para la instancia.
 * Llamar al confirmar state = open.
 *
 * Evolution v2 usa una única URL para todos los eventos cuando
 * webhookByEvents = false (el handler distingue por body.event).
 * Enviamos ambas formas del campo (camelCase + snake_case) para
 * compatibilidad con distintas versiones del build.
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
        enabled:           true,
        url:               `${appOrigin}/api/webhook/evolution`,
        webhookByEvents:   false,
        webhook_by_events: false,
        webhookBase64:     false,
        webhook_base64:    false,
        headers:           { 'x-webhook-secret': secret },
        events: [
          'MESSAGES_UPSERT',
          'MESSAGES_UPDATE',
          'CONNECTION_UPDATE',
        ],
      },
    }),
  }).catch(e => console.warn('[qr/webhook] setup failed (best-effort):', e?.message))

  // Enable readStatus so Evolution fires MESSAGES_UPDATE for delivery/read receipts
  await fetch(`${evoUrl}/settings/set/${encodeURIComponent(instance)}`, {
    method:  'POST',
    headers: { apikey: evoKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ readStatus: true }),
  }).catch(e => console.warn('[qr/settings] readStatus setup failed (best-effort):', e?.message))
}

/**
 * Consulta el estado actual de una instancia en Evolution.
 * Usado internamente antes de restart para no interrumpir sesiones activas.
 */
async function getCurrentState(
  evoUrl:   string,
  evoKey:   string,
  instance: string,
): Promise<'open' | 'connecting' | 'close' | 'notFound'> {
  try {
    const res = await fetch(
      `${evoUrl}/instance/fetchInstances?instanceName=${encodeURIComponent(instance)}`,
      { headers: { apikey: evoKey }, cache: 'no-store' },
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let body: any
    try { body = await res.json() } catch { body = [] }
    return parseInstancesResponse(res.status, body).state
  } catch {
    return 'close'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/lines/qr?instance=xxx[&restart=true]
//
// Genera el QR de la instancia. Llamar SOLO para obtener un QR nuevo.
// Para polling de estado usar GET /api/lines/qr/status.
//
// ?restart=true: fuerza una sesión QR limpia.
//   - Si la instancia está `open` → rechaza (ya conectada).
//   - Si EVOLUTION_GLOBAL_API_KEY está configurado:
//       DELETE + CREATE → sesión Baileys completamente nueva (más confiable).
//   - Fallback sin global key: logout + restart.
//
// Por qué delete+create y no logout+restart:
//   POST /instance/restart devuelve 200 pero puede ser no-op en algunas versiones
//   de Evolution. El estado queda en `close` y el QR devuelto es del caché → inválido.
//   DELETE + CREATE garantiza una sesión Baileys nueva con WebSocket fresco.
// ─────────────────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  // Allow lines:update (admin/líneas) OR warmup:update (operadores de calentamiento)
  const auth = await checkPermissionWithUser(req, 'lines', 'update')
  if (!auth.ok) {
    const auth2 = await checkPermissionWithUser(req, 'warmup', 'update')
    if (!auth2.ok) return auth.response
  }

  const instance = req.nextUrl.searchParams.get('instance')
  if (!instance) return NextResponse.json({ error: 'instance required' }, { status: 400 })
  if (!validInstance(instance)) return NextResponse.json({ error: 'Invalid instance name' }, { status: 400 })

  const EVO_GLOBAL   = process.env.EVOLUTION_GLOBAL_API_KEY
  const EVO_KEY      = EVO_GLOBAL ?? process.env.EVOLUTION_API_KEY ?? ''
  const forceRestart = req.nextUrl.searchParams.get('restart') === 'true'

  try {
    if (forceRestart) {
      const currentState = await getCurrentState(EVO_URL, EVO_KEY, instance)
      console.log('[qr/restart] current state:', currentState)

      if (currentState === 'open') {
        return NextResponse.json({
          connected: true,
          alreadyConnected: true,
          message: 'La instancia ya está conectada. No es necesario regenerar el QR.',
        })
      }

      if (EVO_GLOBAL) {
        // ── Delete + recreate (sesión Baileys garantizada fresca) ─────────────
        console.log('[qr/restart] delete+recreate for fresh Baileys session')
        await fetch(
          `${EVO_URL}/instance/delete/${encodeURIComponent(instance)}`,
          { method: 'DELETE', headers: { apikey: EVO_GLOBAL } },
        ).catch(e => console.warn('[qr/restart] delete error (best-effort):', e?.message))
        await new Promise(r => setTimeout(r, 1500))

        const createRes = await fetch(`${EVO_URL}/instance/create`, {
          method:  'POST',
          headers: { apikey: EVO_GLOBAL, 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            instanceName: instance,
            qrcode:       true,
            integration:  'WHATSAPP-BAILEYS',
          }),
        }).catch(e => { console.error('[qr/restart] create failed:', e?.message); return null })

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let createData: any = {}
        if (createRes) {
          try { createData = await createRes.json() } catch { createData = {} }
          console.log('[qr/restart] create http:', createRes.status, '| hasBase64:', !!extractBase64(createData))
        }

        const createdBase64 = extractBase64(createData)
        if (createdBase64) {
          // Webhook setup best-effort (instance just created, not yet connected)
          const webhookSecret = process.env.EVOLUTION_WEBHOOK_SECRET
          if (webhookSecret) {
            void setupWebhook(EVO_URL, EVO_GLOBAL, instance, new URL(req.url).origin, webhookSecret)
          }
          await query(
            `UPDATE whatsapp_lines SET is_connected = false, updated_at = NOW() WHERE evolution_instance = $1`,
            [instance],
          ).catch(() => {})

          // Verify Baileys is actually connecting (diagnóstico)
          await new Promise(r => setTimeout(r, 1000))
          const stateAfter = await getCurrentState(EVO_URL, EVO_GLOBAL, instance)
          console.log('[qr/restart] state after recreate:', stateAfter)

          return NextResponse.json({ connected: false, base64: createdBase64 })
        }

        // QR no vino en create → esperar y pedir vía /connect
        console.log('[qr/restart] no QR in create response, waiting for Baileys to connect...')
        await new Promise(r => setTimeout(r, 3000))

      } else {
        // ── Fallback sin global key: logout + restart ─────────────────────────
        if (currentState !== 'notFound') {
          console.log('[qr/restart] logout (no global key, using fallback)')
          await fetch(
            `${EVO_URL}/instance/logout/${encodeURIComponent(instance)}`,
            { method: 'DELETE', headers: { apikey: EVO_KEY } },
          ).catch(e => console.warn('[qr/restart] logout error:', e?.message))
          await new Promise(r => setTimeout(r, 1000))
        }
        await fetch(
          `${EVO_URL}/instance/restart/${encodeURIComponent(instance)}`,
          { method: 'POST', headers: { apikey: EVO_KEY } },
        ).catch(e => console.warn('[qr/restart] restart error:', e?.message))
        await new Promise(r => setTimeout(r, 3000))
      }
    }

    // ── Verificar estado actual via fetchInstances (read-only, no perturba la conexión) ──
    // /instance/connect puede devolver shapes inconsistentes cuando el estado es 'open'
    // según la versión del build de Evolution. fetchInstances es más confiable para polling.
    const liveState = await getCurrentState(EVO_URL, EVO_KEY, instance)
    console.log('[qr/status] instance:', instance, '| liveState:', liveState)

    if (liveState === 'notFound') {
      await query(
        `UPDATE whatsapp_lines SET is_connected = false, updated_at = NOW() WHERE evolution_instance = $1`,
        [instance],
      ).catch(() => {})
      return NextResponse.json({ connected: false, base64: null, notFound: true, canCreate: !!EVO_GLOBAL })
    }

    if (liveState === 'open') {
      // Obtener phone_number con fetchInstances (ya disponible desde getCurrentState, pero lo pedimos de nuevo para el phone)
      let phone_number: string | null = null
      try {
        const infoRes = await fetch(
          `${EVO_URL}/instance/fetchInstances?instanceName=${encodeURIComponent(instance)}`,
          { headers: { apikey: EVO_KEY }, cache: 'no-store' },
        )
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let infoBody: any
        try { infoBody = await infoRes.json() } catch { infoBody = [] }
        phone_number = parseInstancesResponse(infoRes.status, infoBody).phone_number
      } catch { /* best-effort */ }

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

    if (liveState === 'connecting') {
      // Instancia en handshake — Evolution no devuelve QR en este estado.
      // El frontend debe mostrar el spinner de "connecting" y esperar sin regenerar.
      return NextResponse.json({ connected: false, base64: null, state: 'connecting' })
    }

    // liveState === 'close' → pedir QR via /instance/connect
    const res = await fetch(`${EVO_URL}/instance/connect/${encodeURIComponent(instance)}`, {
      headers: { apikey: EVO_KEY },
      cache:   'no-store',
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any
    try { data = await res.json() } catch { data = {} }

    console.log(
      '[qr/connect] instance:', instance,
      '| http:', res.status,
      '| hasBase64:', !!extractBase64(data),
    )

    // Desconectada — marcar en DB y devolver QR
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
// DELETE /api/lines/qr?instance=xxx — desvincula la instancia (logout)
//
// Llama a DELETE /instance/logout en Evolution (cierra la sesión WhatsApp)
// y actualiza la DB: is_connected = false, status = 'inactive'.
// NO elimina la línea ni la instancia de Evolution.
// ─────────────────────────────────────────────────────────────────────────────
export async function DELETE(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'update')
  if (err) return err

  const instance = req.nextUrl.searchParams.get('instance')
  if (!instance || !INSTANCE_RE.test(instance)) {
    return NextResponse.json({ error: 'instance required' }, { status: 400 })
  }

  const EVO_KEY = process.env.EVOLUTION_GLOBAL_API_KEY ?? process.env.EVOLUTION_API_KEY ?? ''

  try {
    await fetch(`${EVO_URL}/instance/logout/${encodeURIComponent(instance)}`, {
      method: 'DELETE',
      headers: { apikey: EVO_KEY },
    }).catch(e => console.warn('[qr/unlink] logout error (best-effort):', e?.message))

    await query(
      `UPDATE whatsapp_lines
       SET is_connected = false, status = 'inactive', updated_at = NOW()
       WHERE evolution_instance = $1`,
      [instance],
    )

    void audit({ req, action: 'update', resource: 'lines', metadata: { instance, action: 'unlink' } })

    return NextResponse.json({ unlinked: true })
  } catch (e) {
    console.error('[qr/unlink] error:', e)
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/lines/qr — crea instancia con EVOLUTION_GLOBAL_API_KEY
// ─────────────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  // Allow lines:manage (admin) OR warmup:create (operadores de calentamiento)
  const authPost = await checkPermissionWithUser(req, 'lines', 'manage')
  if (!authPost.ok) {
    const authPost2 = await checkPermissionWithUser(req, 'warmup', 'create')
    if (!authPost2.ok) return authPost.response
  }

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
      // QR no vino en create → pedir via /connect después de que arranque
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
