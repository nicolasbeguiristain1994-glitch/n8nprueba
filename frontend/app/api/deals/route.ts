import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import type { DealStage } from '@/components/kanban/types'

const STAGES: DealStage[] = ['calificado','propuesta','negociacion','cierre','ganado','perdido']

// GET /api/deals — retorna deals agrupados por stage
export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'pipeline', 'read')
  if (!auth.ok) return auth.response

  const { searchParams } = new URL(req.url)
  const ownerFilter = searchParams.get('owner_id')

  const conditions: string[] = []
  const params: unknown[] = []
  let pIdx = 1

  if (ownerFilter) {
    conditions.push(`d.owner_id = $${pIdx++}`)
    params.push(Number(ownerFilter))
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  type DealRow = {
    id: number
    title: string
    amount: string | null
    stage: DealStage
    contact_id: number | null
    contact_name: string | null
    contact_phone: string | null
    owner_id: number | null
    owner_name: string | null
    close_date: string | null
    notes: string | null
    position: number
    created_at: string
    updated_at: string
  }

  const rows = await query<DealRow>(
    `SELECT
       d.id,
       d.title,
       d.amount::text AS amount,
       d.stage,
       d.contact_id,
       c.name  AS contact_name,
       c.phone AS contact_phone,
       d.owner_id,
       u.name  AS owner_name,
       d.close_date::text AS close_date,
       d.notes,
       d.position,
       d.created_at::text,
       d.updated_at::text
     FROM deals d
     LEFT JOIN contacts c ON c.id = d.contact_id
     LEFT JOIN users    u ON u.id = d.owner_id
     ${where}
     ORDER BY d.stage, d.position, d.id`,
    params,
  )

  // Agrupar por stage
  const grouped = Object.fromEntries(STAGES.map(s => [s, []])) as unknown as Record<DealStage, DealRow[]>
  for (const row of rows) {
    if (row.stage in grouped) {
      grouped[row.stage].push(row)
    }
  }

  // Convertir amount string → number
  const result = Object.fromEntries(
    Object.entries(grouped).map(([stage, deals]) => [
      stage,
      deals.map(d => ({ ...d, amount: d.amount != null ? parseFloat(d.amount) : null })),
    ])
  )

  return NextResponse.json(result)
}

// POST /api/deals — crear un deal nuevo
export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'pipeline', 'create')
  if (!auth.ok) return auth.response

  const body = await req.json()
  const { title, amount, stage = 'calificado', contact_id, owner_id, close_date, notes } = body

  if (!title?.trim()) {
    return NextResponse.json({ error: 'title es requerido' }, { status: 400 })
  }

  // Calcular siguiente position en la columna
  const posRows = await query<{ max: string }>(
    'SELECT COALESCE(MAX(position), -1)::text AS max FROM deals WHERE stage = $1',
    [stage],
  )
  const position = parseInt(posRows[0]?.max ?? '-1') + 1

  const insertRows = await query<{ id: number }>(
    `INSERT INTO deals (title, amount, stage, contact_id, owner_id, close_date, notes, position)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      title.trim(),
      amount != null ? Number(amount) : null,
      stage,
      contact_id || null,
      owner_id || null,
      close_date || null,
      notes || null,
      position,
    ],
  )

  return NextResponse.json({ id: insertRows[0].id }, { status: 201 })
}
