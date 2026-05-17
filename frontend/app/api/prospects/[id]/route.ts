import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermissionWithUser } from '@/lib/permissions'

type Params = { params: Promise<{ id: string }> }

// PATCH /api/prospects/[id]
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'manage')
  if (!auth.ok) return auth.response

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  let body: {
    first_name?: string | null
    last_name?:  string | null
    email?:      string | null
    notes?:      string | null
    status?:     string
    opt_in?:     boolean
    tags?:       string[]
  }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (body.status && !['active', 'unsubscribed'].includes(body.status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  }

  try {
    const [row] = await query<{ id: string }>(
      `UPDATE prospects SET
         first_name  = COALESCE($2, first_name),
         last_name   = COALESCE($3, last_name),
         email       = COALESCE($4, email),
         notes       = COALESCE($5, notes),
         status      = COALESCE($6, status),
         opt_in      = COALESCE($7, opt_in),
         tags        = COALESCE($8, tags),
         updated_at  = NOW()
       WHERE id = $1
       RETURNING id`,
      [
        id,
        body.first_name !== undefined ? body.first_name : null,
        body.last_name  !== undefined ? body.last_name  : null,
        body.email      !== undefined ? body.email      : null,
        body.notes      !== undefined ? body.notes      : null,
        body.status     || null,
        body.opt_in     !== undefined ? body.opt_in     : null,
        body.tags       ? `{${body.tags.map(t => `"${t.replace(/"/g, '\\"')}"`).join(',')}}` : null,
      ]
    )
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[PATCH /api/prospects/[id]]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// DELETE /api/prospects/[id]
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'manage')
  if (!auth.ok) return auth.response

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  try {
    const result = await query(
      `DELETE FROM prospects WHERE id = $1 RETURNING id`,
      [id]
    )
    if (!result.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[DELETE /api/prospects/[id]]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
