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

  const { broadcasted } = await req.json() as { broadcasted: boolean }
  const { id: contactId } = await params

  let ok: boolean
  if (broadcasted) {
    const userName = auth.user?.name ?? auth.user?.email ?? 'unknown'
    ok = await service.markBroadcasted(contactId, userName)
  } else {
    ok = await service.unmarkBroadcasted(contactId)
  }

  if (!ok) {
    return NextResponse.json({ error: 'Contacto no encontrado o no elegible' }, { status: 404 })
  }

  return NextResponse.json({ ok: true })
}
