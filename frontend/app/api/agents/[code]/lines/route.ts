import { canAccessAgent } from '@/lib/agent-scope'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { directoryBody, directoryError, NewAgentLineSchema, requireAgentCode } from '@/lib/agent-directory'
export async function POST(req: Request, {params}: {params: Promise<{code:string}>}) {
  const auth = await checkPermissionWithUser(req, 'agents', 'create')
  if (!auth.ok) return auth.response
  try {
    const code = requireAgentCode((await params).code)
    if (!canAccessAgent(auth.user, code)) return Response.json({error:'Agente no permitido'}, {status:403})
    const data = await directoryBody(req, NewAgentLineSchema)
    const [line] = await query<{id:string}>(`INSERT INTO agent_contact_lines(agent_code,linea,variant,label,phone,is_active,link_url)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[code,data.linea,data.variant,data.label,data.phone,data.is_active,data.link_url??null])
    void audit({req,action:'create',resource:'agent_lines',resource_id:line.id,metadata:{code,linea:data.linea,variant:data.variant}})
    return Response.json({ok:true,id:line.id},{status:201})
  } catch(error) { return directoryError(error) }
}
