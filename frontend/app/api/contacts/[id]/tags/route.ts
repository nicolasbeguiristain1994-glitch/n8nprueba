import { NextRequest, NextResponse } from 'next/server'
import { query, withTransaction } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermissionWithUser } from '@/lib/permissions'

// PUT /api/contacts/[id]/tags  — { tags: string[] }
// Replaces all non-casino: custom tags for the contact.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'update')
  if (!auth.ok) return auth.response

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  let body: { tags?: unknown }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!Array.isArray(body.tags)) {
    return NextResponse.json({ error: 'tags must be an array' }, { status: 400 })
  }

  // Sanitize: strings only, trim, no casino: prefix, no empty, max 50 chars, max 20 tags
  const tags = (body.tags as unknown[])
    .filter((t): t is string => typeof t === 'string')
    .map(t => t.trim().toLowerCase().replace(/[^a-z0-9_\-: ]/g, ''))
    .filter(t => t && !t.startsWith('casino:') && t.length <= 50)
    .slice(0, 20)

  try {
    const existing = await query<{ id: string }>('SELECT id FROM contacts WHERE id = $1', [id])
    if (!existing[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    await withTransaction(async (client) => {
      // Remove old custom tags (keep casino: tags intact)
      await client.query(
        `DELETE FROM contact_tags WHERE contact_id = $1 AND tag NOT LIKE 'casino:%'`,
        [id]
      )
      if (tags.length > 0) {
        await client.query(
          `INSERT INTO contact_tags (contact_id, tag)
           SELECT $1, unnest($2::text[])
           ON CONFLICT (contact_id, tag) DO NOTHING`,
          [id, tags]
        )
      }
    })

    return NextResponse.json({ ok: true, tags })
  } catch (e) {
    console.error('[PUT /api/contacts/[id]/tags]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
