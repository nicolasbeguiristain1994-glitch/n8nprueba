import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { emitUpdate } from '@/lib/sse-events'

type Params = { params: Promise<{ phone: string }> }

// GET /api/conversations/[phone]/notes — notas internas del equipo
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await checkPermissionWithUser(req, 'conversations', 'read')
  if (!auth.ok) return auth.response

  const { phone } = await params
  try {
    const notes = await query(
      `SELECT id, content, author_name, created_at
       FROM conversation_notes
       WHERE phone = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [phone]
    )
    return NextResponse.json({ notes })
  } catch (e) {
    console.error('[GET /api/conversations/[phone]/notes]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST /api/conversations/[phone]/notes — agregar nota interna
export async function POST(req: NextRequest, { params }: Params) {
  const auth = await checkPermissionWithUser(req, 'conversations', 'read')
  if (!auth.ok) return auth.response

  const { phone } = await params
  let body: { content?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const content = body.content?.trim()
  if (!content) return NextResponse.json({ error: 'content requerido' }, { status: 400 })

  const authorName = auth.user.name || auth.user.email

  try {
    await query(
      `INSERT INTO conversation_notes (phone, content, author_id, author_name)
       VALUES ($1, $2, $3, $4)`,
      [phone, content, auth.user.user_id, authorName]
    )
    emitUpdate(phone, 'note')
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[POST /api/conversations/[phone]/notes]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
