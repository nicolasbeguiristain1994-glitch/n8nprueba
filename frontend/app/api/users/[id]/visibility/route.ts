/**
 * /api/users/[id]/visibility
 *
 * Gestión de visibilidad de contactos por operador. Solo admin.
 *
 * GET    → lista los contactos asignados al operador (con paginación y búsqueda)
 * POST   → asigna contactos al operador
 * DELETE → desasigna contactos del operador
 */

import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import {
  assignContacts,
  unassignContacts,
  assignAllByFilter,
  unassignAll,
} from '@/lib/contact-visibility'

type RouteContext = { params: Promise<{ id: string }> }

// ── GET — contactos asignados al operador ─────────────────────────────────────

export async function GET(req: NextRequest, { params }: RouteContext) {
  const auth = await checkPermissionWithUser(req, 'users', 'manage')
  if (!auth.ok) return auth.response

  const { id: operatorId } = await params
  if (!isUUID(operatorId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  // Verificar que el usuario existe y es operador/viewer
  const [targetUser] = await query<{ role: string }>(
    'SELECT role FROM users WHERE id = $1 AND is_active = true',
    [operatorId],
  )
  if (!targetUser) return NextResponse.json({ error: 'Usuario no encontrado' }, { status: 404 })

  const search = req.nextUrl.searchParams.get('q') || ''
  const page   = Math.max(1, Number(req.nextUrl.searchParams.get('page') || 1))
  const limit  = 50
  const offset = (page - 1) * limit

  try {
    const [assigned, allResult] = await Promise.all([
      // Contactos actualmente asignados al operador (con búsqueda)
      query(`
        SELECT c.id, c.phone_number, c.first_name, c.last_name, c.segment, c.panel, c.linea,
               ocv.assigned_at,
               u.name AS assigned_by_name
        FROM contacts c
        JOIN operator_contact_visibility ocv ON ocv.contact_id = c.id
        LEFT JOIN users u ON u.id = ocv.assigned_by
        WHERE ocv.operator_id = $1
          AND ($2 = '' OR c.phone_number ILIKE $2 OR c.first_name ILIKE $2 OR c.last_name ILIKE $2)
        ORDER BY ocv.assigned_at DESC
        LIMIT $3 OFFSET $4
      `, [operatorId, `%${search}%`, limit, offset]),

      // Total asignados
      query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM operator_contact_visibility
         WHERE operator_id = $1`,
        [operatorId],
      ),
    ])

    return NextResponse.json({
      contacts:     assigned,
      total:        Number(allResult[0]?.count ?? 0),
      page,
      operator_id:  operatorId,
      operator_role: targetUser.role,
    })
  } catch (e) {
    console.error('[/api/users/[id]/visibility GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── POST — asignar contactos ──────────────────────────────────────────────────

export async function POST(req: NextRequest, { params }: RouteContext) {
  const auth = await checkPermissionWithUser(req, 'users', 'manage')
  if (!auth.ok) return auth.response
  const { user: admin } = auth

  const { id: operatorId } = await params
  if (!isUUID(operatorId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  let body: {
    contact_ids?: string[]
    all?: boolean
    filter?: { panel?: string; segment?: string; linea?: number }
  }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Verificar que el operador existe
  const [targetUser] = await query<{ id: string }>(
    'SELECT id FROM users WHERE id = $1 AND is_active = true',
    [operatorId],
  )
  if (!targetUser) return NextResponse.json({ error: 'Usuario no encontrado' }, { status: 404 })

  try {
    let assigned = 0

    if (body.all) {
      // Asignar todos (opcionalmente con filtro)
      assigned = await assignAllByFilter(operatorId, admin.user_id, body.filter ?? {})
    } else if (Array.isArray(body.contact_ids) && body.contact_ids.length > 0) {
      // Validar que todos los IDs sean UUIDs
      const invalid = body.contact_ids.filter(id => !isUUID(id))
      if (invalid.length > 0) {
        return NextResponse.json({ error: `IDs inválidos: ${invalid.slice(0, 3).join(', ')}` }, { status: 400 })
      }
      assigned = await assignContacts(operatorId, body.contact_ids, admin.user_id)
    } else {
      return NextResponse.json({ error: 'Se requiere contact_ids o all: true' }, { status: 400 })
    }

    void audit({ req, action: 'update', resource: 'users', resource_id: operatorId,
      metadata: { action: 'assign_contacts', assigned, all: body.all ?? false, filter: body.filter } })

    return NextResponse.json({ ok: true, assigned })
  } catch (e) {
    console.error('[/api/users/[id]/visibility POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── DELETE — desasignar contactos ─────────────────────────────────────────────

export async function DELETE(req: NextRequest, { params }: RouteContext) {
  const auth = await checkPermissionWithUser(req, 'users', 'manage')
  if (!auth.ok) return auth.response
  const { user: admin } = auth

  const { id: operatorId } = await params
  if (!isUUID(operatorId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  let body: { contact_ids?: string[]; all?: boolean }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  try {
    let removed = 0

    if (body.all) {
      removed = await unassignAll(operatorId)
    } else if (Array.isArray(body.contact_ids) && body.contact_ids.length > 0) {
      const invalid = body.contact_ids.filter(id => !isUUID(id))
      if (invalid.length > 0) {
        return NextResponse.json({ error: `IDs inválidos: ${invalid.slice(0, 3).join(', ')}` }, { status: 400 })
      }
      removed = await unassignContacts(operatorId, body.contact_ids)
    } else {
      return NextResponse.json({ error: 'Se requiere contact_ids o all: true' }, { status: 400 })
    }

    void audit({ req, action: 'update', resource: 'users', resource_id: operatorId,
      metadata: { action: 'unassign_contacts', removed, all: body.all ?? false } })

    return NextResponse.json({ ok: true, removed })
  } catch (e) {
    console.error('[/api/users/[id]/visibility DELETE]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── GET /api/users/[id]/visibility/available — contactos NO asignados ─────────
// (endpoint separado para el panel de asignación)
// Se implementa como sub-ruta en /api/users/[id]/visibility/available/route.ts
