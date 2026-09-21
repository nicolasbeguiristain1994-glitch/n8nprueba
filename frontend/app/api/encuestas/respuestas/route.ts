import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import {
  sanitizeAnswers,
  sanitizeUsername,
  sanitizeEmail,
  surveySubmitLimiter,
  hashIp,
  getIp,
  clampTracking,
  type Question,
} from '@/lib/encuestas'
import { securityLog } from '@/lib/security-log'

// POST /api/encuestas/respuestas — submit público (no requiere auth).
//
// Body: { slug, answers, campaign?, source?, player_token? }
//
// Flujo:
//   1. Rate limit por IP (10 / 10min).
//   2. Cargar la encuesta activa por slug.
//   3. Validar y sanear answers contra la definición.
//   4. INSERT con ip_hash + user_agent + tracking.
//
// Nota: no devolvemos el id de la respuesta para no exponer un cursor
// escaneable desde el front público.

const CT_JSON = 'application/json'

export async function POST(req: NextRequest) {
  // ── 0. Content-Type ────────────────────────────────────────────────────────
  const ct = req.headers.get('content-type') ?? ''
  if (!ct.includes(CT_JSON)) {
    return NextResponse.json({ error: 'Content-Type inválido' }, { status: 415 })
  }

  // ── 1. Rate limit ──────────────────────────────────────────────────────────
  const ip = getIp(req)
  const rlKey = ip ?? 'anon'
  if (await surveySubmitLimiter.isBlocked(rlKey)) {
    securityLog('rate_limit_exceeded', { ip, resource: 'encuestas', action: 'submit' })
    return NextResponse.json(
      { error: 'Demasiadas respuestas desde tu conexión. Probá en unos minutos.' },
      { status: 429 },
    )
  }

  // ── 2. Parseo body ─────────────────────────────────────────────────────────
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Body inválido' }, { status: 400 })
  }

  const b = body as Record<string, unknown>
  const slug = typeof b.slug === 'string' ? b.slug.trim() : ''
  if (!slug || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) {
    return NextResponse.json({ error: 'Encuesta inválida' }, { status: 400 })
  }

  // ── 3. Username (obligatorio) + email (opcional) ───────────────────────────
  const username = sanitizeUsername(b.username)
  if (!username) {
    return NextResponse.json(
      { error: 'Ingresá tu username (3-60 caracteres, sin espacios ni acentos)' },
      { status: 400 },
    )
  }
  // Si el usuario dejó email en blanco, sanitizeEmail devuelve null y guardamos
  // NULL. Si mandó algo pero no es un email válido, devolvemos error.
  let email: string | null = null
  if (b.email !== undefined && b.email !== null && String(b.email).trim() !== '') {
    email = sanitizeEmail(b.email)
    if (!email) {
      return NextResponse.json({ error: 'El email ingresado no parece válido' }, { status: 400 })
    }
  }

  // ── 4. Cargar encuesta ─────────────────────────────────────────────────────
  const rows = await query<{ id: string; questions: Question[]; is_active: boolean }>(
    `SELECT id, questions, is_active FROM encuestas WHERE slug = $1 LIMIT 1`,
    [slug],
  )
  const encuesta = rows[0]
  if (!encuesta || !encuesta.is_active) {
    return NextResponse.json({ error: 'Encuesta no disponible' }, { status: 404 })
  }

  // ── 5. Validar answers ─────────────────────────────────────────────────────
  const result = sanitizeAnswers(b.answers, encuesta.questions)
  if (!result.ok) {
    // Incrementamos rate-limit igual — mitiga abuso de intentos con basura.
    await surveySubmitLimiter.increment(rlKey)
    return NextResponse.json({ error: result.error }, { status: 400 })
  }

  // ── 6. Tracking sanitizado ─────────────────────────────────────────────────
  const campaign     = clampTracking(b.campaign)
  const source       = clampTracking(b.source)
  const playerToken  = typeof b.player_token === 'string' && b.player_token.length <= 128
    ? b.player_token.trim() || null
    : null

  const userAgent = (req.headers.get('user-agent') ?? '').slice(0, 300) || null
  const ipHash = hashIp(ip)

  // ── 7. INSERT ──────────────────────────────────────────────────────────────
  try {
    await query(
      `INSERT INTO encuesta_respuestas
        (encuesta_id, answers, campaign, source, player_token,
         username, email, ip_hash, user_agent)
       VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9)`,
      [
        encuesta.id,
        JSON.stringify(result.answers),
        campaign,
        source,
        playerToken,
        username,
        email,
        ipHash,
        userAgent,
      ],
    )
    await surveySubmitLimiter.increment(rlKey)
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/encuestas/respuestas POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'No pudimos guardar tu respuesta' }, { status: 500 })
  }
}
