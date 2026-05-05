import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'

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

// ── GET /api/dashboard/crm ────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'dashboard', 'read')
  if (!auth.ok) return auth.response

  try {
    const [kpiRows, tasks, recentContacts, recentTasks] = await Promise.all([
      query<{ contacts: string; tasks_pending: string; tasks_overdue: string }>(`
        SELECT
          (SELECT COUNT(*)::text FROM contacts)                                         AS contacts,
          (SELECT COUNT(*)::text FROM tasks WHERE status != 'done')                    AS tasks_pending,
          (SELECT COUNT(*)::text FROM tasks WHERE status != 'done' AND due_date < NOW()) AS tasks_overdue
      `),
      query<PendingTask>(`
        SELECT id, title, due_date, priority, assigned_to
        FROM tasks
        WHERE status != 'done'
        ORDER BY
          CASE priority WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END,
          due_date ASC NULLS LAST
        LIMIT 10
      `),
      query<{ title: string; created_at: string }>(`
        SELECT COALESCE(first_name || ' ' || last_name, phone_number) AS title, created_at
        FROM contacts
        ORDER BY created_at DESC
        LIMIT 5
      `),
      query<{ title: string; created_at: string }>(`
        SELECT title, updated_at AS created_at
        FROM tasks
        WHERE status = 'done'
        ORDER BY updated_at DESC
        LIMIT 5
      `),
    ])

    const raw = kpiRows[0] ?? { contacts: '0', tasks_pending: '0', tasks_overdue: '0' }
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
