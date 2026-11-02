import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { AGENT_KEYS } from '@/lib/agent-scope'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { audit } from '@/lib/audit'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await checkPermissionWithUser(req, 'campaigns', 'manage')
  if (!auth.ok) return auth.response
  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!isUUID(id) || !body || !(body.agent_key === null || AGENT_KEYS.includes(body.agent_key))) {
    return NextResponse.json({ error: 'Agente o campaña inválidos' }, { status: 400 })
  }
  try {
    const rows = await query(`UPDATE campaigns SET agent_key=$2,updated_by=$3,updated_at=NOW()
      WHERE id=$1 RETURNING id`, [id,body.agent_key,auth.user.user_id])
    if (!rows.length) return NextResponse.json({ error: 'Campaña no encontrada' }, { status: 404 })
    void audit({ req, action: 'update', resource: 'campaigns', resource_id: id, metadata: { agent_key: body.agent_key } })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'No se pudo asignar el agente' }, { status: 500 })
  }
}
