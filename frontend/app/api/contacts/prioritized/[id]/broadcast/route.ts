import { z } from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { UserPrioritizationService } from '@/lib/user-prioritization/UserPrioritizationService'

const service = new UserPrioritizationService()

// PATCH /api/contacts/prioritized/[id]/broadcast
// body: { broadcasted: true }  → marca como difundido
// body: { broadcasted: false } → quita la marca
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'manage')
  if (!auth.ok) return auth.response

  const body = await req.json().catch(() => null)
  const parsed = z.object({ broadcasted: z.boolean() }).safeParse(body)
  const id = z.string().uuid().safeParse((await params).id)
  if (!parsed.success || !id.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 })
  const { broadcasted } = parsed.data
  const contactId = id.data
  const access = { role: auth.user.role, userId: auth.user.user_id, allowedAgents: auth.user.allowed_agents }

  let ok: boolean
  if (broadcasted) {
    const userName = auth.user?.name ?? auth.user?.email ?? 'unknown'
    ok = await service.markBroadcasted(contactId, userName, access)
  } else {
    ok = await service.unmarkBroadcasted(contactId, access)
  }

  if (!ok) {
    return NextResponse.json({ error: 'Contacto no encontrado o no elegible' }, { status: 404 })
  }

  return NextResponse.json({ ok: true })
}
