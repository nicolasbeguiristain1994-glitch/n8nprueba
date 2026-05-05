import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'

export interface CrmKPIs {
  total_deals: number
  total_deals_value: number
  won_deals: number
  won_deals_value: number
  contacts: number
  tasks_pending: number
  tasks_overdue: number
  conversion_rate: number
}

export interface RevenueTrendPoint {
  month: string
  revenue: number
  deals_closed: number
}

export interface PipelineStage {
  stage: string
  label: string
  count: number
  value: number
}

export interface DealClosingSoon {
  id: number
  title: string
  amount: number | null
  stage: string
  close_date: string
  contact_name: string | null
  owner_name: string | null
  days_left: number
}

export interface PendingTask {
  id: string
  title: string
  type: string
  priority: string
  status: string
  due_date: string | null
  assignee_name: string | null
}

export interface TopContact {
  id: number
  name: string
  phone: string | null
  deals_count: number
  total_value: number
  last_deal_date: string | null
}

export interface RecentActivity {
  id: string
  type: 'deal_created' | 'deal_won' | 'task_completed' | 'contact_added'
  title: string
  description: string
  timestamp: string
}

export interface CrmDashboardData {
  kpis: CrmKPIs
  revenue_trend: RevenueTrendPoint[]
  pipeline: PipelineStage[]
  closing_soon: DealClosingSoon[]
  tasks: PendingTask[]
  top_contacts: TopContact[]
  recent_activity: RecentActivity[]
}

const STAGE_LABELS: Record<string, string> = {
  calificado: 'Calificado',
  propuesta: 'Propuesta',
  negociacion: 'Negociación',
  cierre: 'Cierre',
  ganado: 'Ganado',
  perdido: 'Perdido',
}

function parseDate(raw: string | null, fallback: () => Date): Date {
  if (!raw) return fallback()
  const d = new Date(raw)
  return isNaN(d.getTime()) ? fallback() : d
}

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'pipeline', 'read')
  if (!auth.ok) return auth.response

  try {
    const { searchParams } = new URL(req.url)

    const defaultTo   = new Date()
    const defaultFrom = new Date(defaultTo)
    defaultFrom.setDate(defaultFrom.getDate() - 7)

    const dateFrom = parseDate(searchParams.get('from'), () => defaultFrom)
    const dateTo   = parseDate(searchParams.get('to'),   () => defaultTo)

    const dateToEOD = new Date(dateTo)
    dateToEOD.setHours(23, 59, 59, 999)

    // ── KPIs ────────────────────────────────────────────────────────────────────
    // deals y contacts no tienen deleted_at — tasks sí lo tiene
    const [dealKpis, periodWon, contactCount, taskStats] = await Promise.all([
      query<{ total_deals: string; total_value: string }>(`
        SELECT
          COUNT(*)                          AS total_deals,
          COALESCE(SUM(amount), 0)::text    AS total_value
        FROM deals
        WHERE stage NOT IN ('perdido')
      `, []),

      query<{ won_deals: string; won_value: string }>(`
        SELECT
          COUNT(*)                          AS won_deals,
          COALESCE(SUM(amount), 0)::text    AS won_value
        FROM deals
        WHERE stage = 'ganado'
          AND updated_at BETWEEN $1 AND $2
      `, [dateFrom, dateToEOD]),

      query<{ total: string }>(`
        SELECT COUNT(*) AS total FROM contacts
      `, []),

      query<{ pending: string; overdue: string }>(`
        SELECT
          COUNT(*) FILTER (WHERE status IN ('pendiente','en_progreso'))                         AS pending,
          COUNT(*) FILTER (WHERE status IN ('pendiente','en_progreso') AND due_date < NOW())    AS overdue
        FROM tasks
        WHERE deleted_at IS NULL
      `, []),
    ])

    const totalDeals = parseInt(dealKpis[0]?.total_deals ?? '0')
    const wonDeals   = parseInt(periodWon[0]?.won_deals  ?? '0')

    const kpis: CrmKPIs = {
      total_deals:       totalDeals,
      total_deals_value: parseFloat(dealKpis[0]?.total_value ?? '0'),
      won_deals:         wonDeals,
      won_deals_value:   parseFloat(periodWon[0]?.won_value  ?? '0'),
      contacts:          parseInt(contactCount[0]?.total ?? '0'),
      tasks_pending:     parseInt(taskStats[0]?.pending  ?? '0'),
      tasks_overdue:     parseInt(taskStats[0]?.overdue  ?? '0'),
      conversion_rate:   totalDeals > 0 ? Math.round((wonDeals / totalDeals) * 100) : 0,
    }

    // ── Revenue trend ────────────────────────────────────────────────────────────
    const trendRows = await query<{ month: string; revenue: string; deals_closed: string }>(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', updated_at), 'Mon YY') AS month,
        COALESCE(SUM(amount), 0)::text                      AS revenue,
        COUNT(*)::text                                       AS deals_closed
      FROM deals
      WHERE stage = 'ganado'
        AND updated_at BETWEEN $1 AND $2
      GROUP BY DATE_TRUNC('month', updated_at)
      ORDER BY DATE_TRUNC('month', updated_at)
    `, [dateFrom, dateToEOD])

    const revenue_trend: RevenueTrendPoint[] = trendRows.map(r => ({
      month:        r.month,
      revenue:      parseFloat(r.revenue),
      deals_closed: parseInt(r.deals_closed),
    }))

    // ── Pipeline summary ─────────────────────────────────────────────────────────
    const pipelineRows = await query<{ stage: string; count: string; value: string }>(`
      SELECT
        stage,
        COUNT(*)::text                 AS count,
        COALESCE(SUM(amount), 0)::text AS value
      FROM deals
      WHERE stage NOT IN ('ganado','perdido')
      GROUP BY stage
      ORDER BY CASE stage
        WHEN 'calificado'  THEN 1
        WHEN 'propuesta'   THEN 2
        WHEN 'negociacion' THEN 3
        WHEN 'cierre'      THEN 4
        ELSE 5
      END
    `, [])

    const pipeline: PipelineStage[] = pipelineRows.map(r => ({
      stage: r.stage,
      label: STAGE_LABELS[r.stage] ?? r.stage,
      count: parseInt(r.count),
      value: parseFloat(r.value),
    }))

    // ── Deals closing soon ───────────────────────────────────────────────────────
    const closingRows = await query<{
      id: number; title: string; amount: string | null
      stage: string; close_date: string
      contact_name: string | null; owner_name: string | null
    }>(`
      SELECT
        d.id, d.title, d.amount::text, d.stage,
        d.close_date::text,
        c.name AS contact_name,
        u.name AS owner_name
      FROM deals d
      LEFT JOIN contacts c ON c.id = d.contact_id
      LEFT JOIN users    u ON u.id = d.owner_id
      WHERE d.close_date IS NOT NULL
        AND d.close_date BETWEEN NOW() AND NOW() + INTERVAL '14 days'
        AND d.stage NOT IN ('ganado','perdido')
      ORDER BY d.close_date
      LIMIT 8
    `, [])

    const closing_soon: DealClosingSoon[] = closingRows.map(r => ({
      id:           r.id,
      title:        r.title,
      amount:       r.amount != null ? parseFloat(r.amount) : null,
      stage:        r.stage,
      close_date:   r.close_date,
      contact_name: r.contact_name,
      owner_name:   r.owner_name,
      days_left:    Math.ceil((new Date(r.close_date).getTime() - Date.now()) / 86400000),
    }))

    // ── Pending tasks ────────────────────────────────────────────────────────────
    const taskRows = await query<{
      id: string; title: string; type: string; priority: string
      status: string; due_date: string | null; assignee_name: string | null
    }>(`
      SELECT
        t.id::text, t.title, t.type, t.priority, t.status,
        t.due_date::text,
        u.name AS assignee_name
      FROM tasks t
      LEFT JOIN task_assignees ta ON ta.task_id = t.id
      LEFT JOIN users          u  ON u.id = ta.user_id
      WHERE t.deleted_at IS NULL
        AND t.status IN ('pendiente','en_progreso')
      ORDER BY
        CASE t.priority WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END,
        t.due_date NULLS LAST
      LIMIT 6
    `, [])

    const tasks: PendingTask[] = taskRows.map(r => ({
      id:            r.id,
      title:         r.title,
      type:          r.type,
      priority:      r.priority,
      status:        r.status,
      due_date:      r.due_date,
      assignee_name: r.assignee_name,
    }))

    // ── Top contacts by deal value ────────────────────────────────────────────────
    const contactRows = await query<{
      id: number; name: string; phone: string | null
      deals_count: string; total_value: string; last_deal_date: string | null
    }>(`
      SELECT
        c.id, c.name, c.phone,
        COUNT(d.id)::text                AS deals_count,
        COALESCE(SUM(d.amount), 0)::text AS total_value,
        MAX(d.created_at)::text          AS last_deal_date
      FROM contacts c
      JOIN deals d ON d.contact_id = c.id
      GROUP BY c.id, c.name, c.phone
      ORDER BY SUM(d.amount) DESC NULLS LAST
      LIMIT 6
    `, [])

    const top_contacts: TopContact[] = contactRows.map(r => ({
      id:             r.id,
      name:           r.name,
      phone:          r.phone,
      deals_count:    parseInt(r.deals_count),
      total_value:    parseFloat(r.total_value),
      last_deal_date: r.last_deal_date,
    }))

    // ── Recent activity ──────────────────────────────────────────────────────────
    const activityRows = await query<{
      id: string; type: string; title: string; description: string; timestamp: string
    }>(`
      (SELECT
        id::text, 'deal_created' AS type,
        'Nuevo deal: ' || title AS title,
        COALESCE('Por ' || (SELECT name FROM users WHERE id = owner_id), '') AS description,
        created_at::text AS timestamp
      FROM deals
      WHERE created_at BETWEEN $1 AND $2
      ORDER BY created_at DESC LIMIT 3)
      UNION ALL
      (SELECT
        id::text, 'deal_won' AS type,
        'Deal ganado: ' || title AS title,
        '$' || COALESCE(amount::text, '0') AS description,
        updated_at::text AS timestamp
      FROM deals
      WHERE stage = 'ganado' AND updated_at BETWEEN $1 AND $2
      ORDER BY updated_at DESC LIMIT 3)
      UNION ALL
      (SELECT
        id::text, 'task_completed' AS type,
        'Tarea completada: ' || title AS title,
        type AS description,
        updated_at::text AS timestamp
      FROM tasks
      WHERE status = 'completada' AND deleted_at IS NULL AND updated_at BETWEEN $1 AND $2
      ORDER BY updated_at DESC LIMIT 3)
      UNION ALL
      (SELECT
        id::text, 'contact_added' AS type,
        'Nuevo contacto: ' || name AS title,
        COALESCE(phone, '') AS description,
        created_at::text AS timestamp
      FROM contacts
      WHERE created_at BETWEEN $1 AND $2
      ORDER BY created_at DESC LIMIT 3)
      ORDER BY timestamp DESC
      LIMIT 8
    `, [dateFrom, dateToEOD])

    const recent_activity: RecentActivity[] = activityRows.map(r => ({
      id:          r.id,
      type:        r.type as RecentActivity['type'],
      title:       r.title,
      description: r.description,
      timestamp:   r.timestamp,
    }))

    return NextResponse.json({
      kpis,
      revenue_trend,
      pipeline,
      closing_soon,
      tasks,
      top_contacts,
      recent_activity,
    } satisfies CrmDashboardData)

  } catch (err) {
    console.error('[dashboard/crm]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
