import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { visibilityClause } from '@/lib/contact-visibility'

// ── Types ─────────────────────────────────────────────────────────────────────

export type CrmKPIs = {
  contacts:      number
  tasks_pending: number
  tasks_overdue: number
}

export type PendingTask = {
  id:          string
  title:       string
  due_date:    string | null
  priority:    string
  assigned_to: string | null
}

export type RecentActivity = {
  type:       'task_completed' | 'contact_added'
  title:      string
  sub:        string
  created_at: string
}

export type CrmDashboardData = {
  kpis:            CrmKPIs
  tasks:           PendingTask[]
  recent_activity: RecentActivity[]
}

export type DealClosingSoon = {
  id:           string
  title:        string
  days_left:    number
  contact_name: string | null
  stage:        string
  amount:       number | null
}

export type PipelineStage = {
  stage: string
  label: string
  count: number
  value: number
}

export type RevenueTrendPoint = {
  month:   string
  revenue: number
}

export type TopContact = {
  id:          string
  name:        string
  deals_count: number
  total_value: number
}

// ── GET /api/dashboard/crm ────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'dashboard', 'read')
  if (!auth.ok) return auth.response
  const { user } = auth
  const isAdmin = user.role === 'admin'
  const canReadContacts = isAdmin || user.sectors?.includes('contacts')
  const canReadTasks = isAdmin || user.sectors?.includes('tasks')
  const visibility = visibilityClause(user.role, user.user_id, 0, 'c')
  const contactParams: unknown[] = [...visibility.params]
  let contactWhere = `c.deleted_at IS NULL ${visibility.sql}`
  if (!canReadContacts) contactWhere += ' AND FALSE'
  if (!isAdmin && user.allowed_agents?.length) {
    contactParams.push(user.allowed_agents)
    contactWhere += ` AND c.panel = ANY($${contactParams.length}::text[])`
  }
  const taskWhere = !canReadTasks ? 'AND FALSE' : isAdmin ? ''
    : 'AND EXISTS (SELECT 1 FROM task_assignees scope WHERE scope.task_id=t.id AND scope.user_id=$1)'
  const taskParams = !isAdmin && canReadTasks ? [user.user_id] : []

  try {
    const [contactCounts, taskCounts, tasks, recentContacts, recentTasks] = await Promise.all([
      query<{ contacts: string }>(`SELECT COUNT(*)::text AS contacts FROM contacts c WHERE ${contactWhere}`, contactParams),
      query<{ tasks_pending: string; tasks_overdue: string }>(`
        SELECT
          COUNT(*)::text AS tasks_pending,
          COUNT(*) FILTER (WHERE t.due_date < NOW())::text AS tasks_overdue
        FROM tasks t WHERE t.deleted_at IS NULL AND t.status IN ('pendiente','en_progreso') ${taskWhere}
      `, taskParams),
      query<PendingTask>(`
        SELECT t.id, t.title, t.due_date, t.priority,
          (SELECT STRING_AGG(COALESCE(u.name, u.email), ', ' ORDER BY u.name)
           FROM task_assignees ta JOIN users u ON u.id = ta.user_id
           WHERE ta.task_id = t.id) AS assigned_to
        FROM tasks t
        WHERE t.deleted_at IS NULL AND t.status IN ('pendiente','en_progreso') ${taskWhere}
        ORDER BY
          CASE priority WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END,
          due_date ASC NULLS LAST
        LIMIT 10
      `, taskParams),
      query<{ title: string; created_at: string }>(`
        SELECT COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)),''), c.phone_number) AS title, c.created_at
        FROM contacts c WHERE ${contactWhere}
        ORDER BY created_at DESC
        LIMIT 5
      `, contactParams),
      query<{ title: string; created_at: string }>(`
        SELECT t.title, t.updated_at AS created_at
        FROM tasks t
        WHERE t.deleted_at IS NULL AND t.status = 'completada' ${taskWhere}
        ORDER BY updated_at DESC
        LIMIT 5
      `, taskParams),
    ])

    const raw = { contacts: contactCounts[0]?.contacts ?? '0', tasks_pending: taskCounts[0]?.tasks_pending ?? '0', tasks_overdue: taskCounts[0]?.tasks_overdue ?? '0' }
    const kpis: CrmKPIs = {
      contacts:      parseInt(raw.contacts,      10),
      tasks_pending: parseInt(raw.tasks_pending, 10),
      tasks_overdue: parseInt(raw.tasks_overdue, 10),
    }

    const recent_activity: RecentActivity[] = [
      ...recentContacts.map(r => ({
        type:       'contact_added' as const,
        title:      r.title,
        sub:        new Date(r.created_at).toLocaleDateString('es-AR'),
        created_at: r.created_at,
      })),
      ...recentTasks.map(r => ({
        type:       'task_completed' as const,
        title:      r.title,
        sub:        new Date(r.created_at).toLocaleDateString('es-AR'),
        created_at: r.created_at,
      })),
    ]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 8)

    return NextResponse.json({ kpis, tasks, recent_activity } satisfies CrmDashboardData)
  } catch (e) {
    console.error('[GET /api/dashboard/crm]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
