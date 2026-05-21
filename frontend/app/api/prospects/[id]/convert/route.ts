import { NextRequest, NextResponse } from 'next/server'
import { withTransaction } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import type { PoolClient } from 'pg'

type Params = { params: Promise<{ id: string }> }

// POST /api/prospects/[id]/convert
//
// Convierte un prospect a contacto en una transacción atómica:
//   1. Verifica que el prospect exista, esté activo y no convertido
//   2. Inserta el contacto (ON CONFLICT DO NOTHING devuelve el id existente si colisiona)
//   3. Actualiza el prospect: status='converted', converted_to_contact_id
//
// Respuestas:
//   201 { contact_id }           — conversión exitosa, contacto creado
//   409 { error, contact_id }    — número ya existe en contacts; prospect se marca igualmente
//   409 { error }                — prospect ya fue convertido anteriormente
//   400 / 403 / 404              — validación / permisos / no encontrado

export async function POST(req: NextRequest, { params }: Params) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'manage')
  if (!auth.ok) return auth.response

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  let body: { notes?: string | null } = {}
  try { body = await req.json() } catch { /* notes opcional */ }
  const notes = (body.notes ?? '').trim() || null

  try {
    const result = await withTransaction(async (client: PoolClient) => {
      // 1. Bloquear y leer prospect
      const { rows: pRows } = await client.query<{
        id: string; phone_number: string; first_name: string | null;
        last_name: string | null; email: string | null;
        status: string; converted_to_contact_id: string | null
      }>(
        `SELECT id, phone_number, first_name, last_name, email, status, converted_to_contact_id
         FROM prospects WHERE id = $1 FOR UPDATE`,
        [id]
      )
      if (!pRows.length) return { notFound: true } as const

      const prospect = pRows[0]
      if (prospect.status === 'converted' && prospect.converted_to_contact_id) {
        return { alreadyConverted: true, contact_id: prospect.converted_to_contact_id } as const
      }
      if (prospect.status === 'unsubscribed') {
        return { unsubscribed: true } as const
      }

      // 2. Insertar contacto
      const { rows: cRows } = await client.query<{ id: string }>(
        `INSERT INTO contacts
           (external_id, phone_number, first_name, last_name, email, notes,
            status, opt_in_marketing, opt_in_sms, platform_source, created_at, updated_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5,
                 'active', true, true, 'prospect_conversion', NOW(), NOW())
         ON CONFLICT (phone_number) DO NOTHING
         RETURNING id`,
        [prospect.phone_number, prospect.first_name, prospect.last_name, prospect.email, notes]
      )

      let contactId: string
      let phoneConflict = false

      if (cRows.length) {
        contactId = cRows[0].id
      } else {
        // El teléfono ya existe — tomamos el id del contacto existente
        phoneConflict = true
        const { rows: existing } = await client.query<{ id: string }>(
          `SELECT id FROM contacts WHERE phone_number = $1`,
          [prospect.phone_number]
        )
        contactId = existing[0].id
      }

      // 3. Marcar prospect como convertido
      await client.query(
        `UPDATE prospects
         SET status = 'converted', converted_to_contact_id = $2, updated_at = NOW()
         WHERE id = $1`,
        [id, contactId]
      )

      return { contactId, phoneConflict } as const
    })

    if ('notFound' in result && result.notFound) {
      return NextResponse.json({ error: 'Prospect not found' }, { status: 404 })
    }
    if ('alreadyConverted' in result && result.alreadyConverted) {
      return NextResponse.json(
        { error: 'El prospect ya fue convertido', contact_id: result.contact_id },
        { status: 409 }
      )
    }
    if ('unsubscribed' in result && result.unsubscribed) {
      return NextResponse.json(
        { error: 'No se puede convertir un prospect dado de baja' },
        { status: 400 }
      )
    }

    const { contactId, phoneConflict } = result as { contactId: string; phoneConflict: boolean }

    void audit({
      req, action: 'update', resource: 'prospects', resource_id: id,
      metadata: { action: 'convert', contact_id: contactId, phone_conflict: phoneConflict },
    })

    if (phoneConflict) {
      return NextResponse.json(
        {
          contact_id: contactId,
          warning: 'El teléfono ya existía en contactos. El prospect fue vinculado al contacto existente.',
        },
        { status: 200 }
      )
    }

    return NextResponse.json({ contact_id: contactId }, { status: 201 })
  } catch (e) {
    console.error('[POST /api/prospects/[id]/convert]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
