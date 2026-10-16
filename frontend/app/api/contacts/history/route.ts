import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { contactScope } from '@/lib/contact-visibility'
import { contactRead, ContactReadUnavailableError } from '@/lib/contact-read'
import { readContactHistory } from '@/lib/contact-history'

/** Bounded enrichment for one visible page. IDs never bypass contact access. */
export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'read')
  if (!auth.ok) return auth.response
  const sp = req.nextUrl.searchParams
  const ids = sp.get('ids')?.split(',') ?? []
  const fields = sp.get('fields') ?? 'all'
  if (!ids.length || ids.length > 50 || ids.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) || !['all', 'broadcast'].includes(fields)) {
    return NextResponse.json({ error: 'Página de contactos inválida' }, { status: 400 })
  }
  try {
    const scope = contactScope(auth.user, 1)
    const rows = await contactRead<{ id: string; phone_number: string }>(
      `SELECT id,phone_number FROM contacts WHERE id=ANY($1::uuid[]) AND ${scope.sql}`,
      [[...new Set(ids)], ...scope.params],
    )
    const history = await readContactHistory(rows, undefined, fields === 'all')
    return NextResponse.json({ history }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    if (error instanceof ContactReadUnavailableError) return NextResponse.json({ error: error.message }, { status: 503, headers: { 'Retry-After': '3' } })
    console.error('[/api/contacts/history GET]', error instanceof Error ? error.message : error)
    return NextResponse.json({ error: 'No se pudo cargar el historial de contactos' }, { status: 500 })
  }
}
