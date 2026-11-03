import { canAccessAgent } from '@/lib/agent-scope'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { AgentNameSchema, directoryBody, directoryError, requireAgentCode } from '@/lib/agent-directory'
export async function PATCH(req: Request, {params}: {params: Promise<{code:string}>}) {
  const auth = await checkPermissionWithUser(req, 'agents', 'update')
  if (!auth.ok) return auth.response
  try {
    const code = requireAgentCode((await params).code)
    if (!canAccessAgent(auth.user, code)) return Response.json({error:'Agente no permitido'}, {status:403})
    const data = await directoryBody(req, AgentNameSchema)
    const rows = await query('UPDATE crm_agents SET name=$2,updated_at=NOW() WHERE code=$1 RETURNING code',[code,data.name])
    if (!rows.length) return Response.json({error:'Agente no encontrado'},{status:404})
    void audit({req,action:'update',resource:'agents',metadata:{code}})
    return Response.json({ok:true})
  } catch(error) { return directoryError(error) }
}
