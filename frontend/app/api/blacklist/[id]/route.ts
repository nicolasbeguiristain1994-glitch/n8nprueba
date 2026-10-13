import { NextRequest, NextResponse } from 'next/server'
import { reinstateGlobalContact } from '@/lib/global-opt-out'
import { sseEmitter } from '@/lib/sse-events'
import { checkPermissionWithUser } from '@/lib/permissions'
import { isUUID } from '@/lib/validate'
import { audit } from '@/lib/audit'

// ── DELETE /api/blacklist/[id] — Soft-delete (quitar de blacklist) ─────────────

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await checkPermissionWithUser(req, 'blacklist', 'manage')
  if (!auth.ok) return auth.response
  const session = auth.user

  const { id } = await params

  if (!isUUID(id)) {
    return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
  }

  try {
    const body = await req.json().catch(() => null)
    if (body?.consent_confirmed !== true || typeof body?.consent_note !== 'string' || body.consent_note.trim().length < 10 || body.consent_note.length > 2000) {
      return NextResponse.json({error:'Confirmá el nuevo consentimiento y registrá cómo lo obtuviste (10 a 2000 caracteres).'}, {status:400})
    }
    const removed = await reinstateGlobalContact(id, session.user_id, body.consent_note)
    if (!removed) return NextResponse.json({error:'Registro no encontrado o ya fue removido'}, {status:404})
    sseEmitter.emit('update', {source:'message'})

    void audit({
      req,
      action: 'delete',
      resource: 'blacklist',
      resource_id: id,
      metadata: { scope:'global', consent_note:body.consent_note.trim() },
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/blacklist/[id] DELETE]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
