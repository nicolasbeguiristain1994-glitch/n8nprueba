import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'

// POST /api/contacts/import/check
// Recibe una lista de teléfonos y retorna cuáles ya existen en contacts,
// agrupados por panel (agente), para que el usuario decida si actualizarlos o no.
//
// Body: { phones: string[] }
// Returns: { total: number, by_panel: { [panel: string]: number }, sample: string[] }

export async function POST(req: NextRequest) {
  const err = await checkPermission(req, 'contacts', 'read')
  if (err) return err

  let body: { phones?: string[] }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const phones = body.phones
  if (!Array.isArray(phones) || phones.length === 0) {
    return NextResponse.json({ total: 0, by_panel: {}, sample: [] })
  }

  try {
    const rows = await query<{ phone_number: string; panel: string | null }>(
      `SELECT phone_number, panel
       FROM contacts
       WHERE phone_number = ANY($1::text[])`,
      [phones]
    )

    const byPanel: Record<string, number> = {}
    for (const r of rows) {
      const key = r.panel ?? '(sin agente)'
      byPanel[key] = (byPanel[key] ?? 0) + 1
    }

    return NextResponse.json({
      total:    rows.length,
      by_panel: byPanel,
    })
  } catch (e) {
    console.error('[contacts/import/check]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
