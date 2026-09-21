import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { parseBody, handleValidationError } from '@/lib/schema'
import { EncuestaSchema } from '@/lib/encuestas'

// GET /api/encuestas — listado admin (con conteo de respuestas).
export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'encuestas', 'read')
  if (!auth.ok) return auth.response

  try {
    const rows = await query<{
      id: string; slug: string; title: string; description: string | null
      is_active: boolean; created_at: string; updated_at: string
      questions_count: number; respuestas_count: number
    }>(`
      SELECT
        e.id, e.slug, e.title, e.description, e.is_active,
        e.created_at, e.updated_at,
        jsonb_array_length(e.questions)::int  AS questions_count,
        COALESCE(r.cnt, 0)::int               AS respuestas_count
      FROM encuestas e
      LEFT JOIN (
        SELECT encuesta_id, COUNT(*)::int AS cnt
          FROM encuesta_respuestas
         GROUP BY encuesta_id
      ) r ON r.encuesta_id = e.id
      ORDER BY e.created_at DESC
    `)
    return NextResponse.json({ encuestas: rows })
  } catch (e) {
    console.error('[/api/encuestas GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST /api/encuestas — crear.
export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'encuestas', 'create')
  if (!auth.ok) return auth.response

  const body = await req.json().catch(() => null)
  const parsed = parseBody(EncuestaSchema, body)
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'encuestas')

  const { slug, title, description, questions, is_active } = parsed.data

  // Validar IDs únicos dentro del array
  const ids = new Set<string>()
  for (const q of questions) {
    if (ids.has(q.id)) {
      return NextResponse.json({ error: `ID de pregunta duplicado: ${q.id}` }, { status: 400 })
    }
    ids.add(q.id)
  }

  try {
    const [row] = await query<{ id: string }>(
      `INSERT INTO encuestas (slug, title, description, questions, is_active, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       RETURNING id`,
      [
        slug,
        title,
        description ?? null,
        JSON.stringify(questions),
        is_active ?? true,
        auth.user.user_id === 'bootstrap' ? null : auth.user.user_id,
      ],
    )
    void audit({ req, action: 'create', resource: 'encuestas', resource_id: row.id, metadata: { slug } })
    return NextResponse.json({ id: row.id }, { status: 201 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('encuestas_slug_key')) {
      return NextResponse.json({ error: `El slug "${slug}" ya está en uso` }, { status: 409 })
    }
    console.error('[/api/encuestas POST]', msg)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
