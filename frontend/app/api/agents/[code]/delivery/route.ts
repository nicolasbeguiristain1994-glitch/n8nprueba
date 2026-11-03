import { canAccessAgent } from '@/lib/agent-scope'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { AgentDeliverySchema, directoryBody, directoryError, requireAgentCode } from '@/lib/agent-directory'

export async function PATCH(req: Request, {params}: {params: Promise<{code:string}>}) {
  const auth = await checkPermissionWithUser(req, 'agents', 'update')
  if (!auth.ok) return auth.response
  try {
    const code = requireAgentCode((await params).code)
    if (!canAccessAgent(auth.user, code)) return Response.json({error:'Agente no permitido'}, {status:403})
    const data = await directoryBody(req, AgentDeliverySchema)
    const rows = await query(`UPDATE crm_agents SET delivery_mode=$2,phone_format=COALESCE($3::text,phone_format),updated_at=NOW() WHERE code=$1 RETURNING code,delivery_mode,phone_format`, [code,data.delivery_mode,data.phone_format ?? null])
    if (!rows.length) return Response.json({error:'Agente no encontrado'}, {status:404})
    void audit({req,action:'update',resource:'agents',metadata:rows[0]})
    return Response.json({ok:true,...rows[0]})
  } catch(error) { return directoryError(error) }
}
