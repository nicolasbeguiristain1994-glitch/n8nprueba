import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { directoryBody, directoryError, NewAgentLineSchema, requireAgentCode } from '@/lib/agent-directory'
export async function POST(req: Request, {params}: {params: Promise<{code:string}>}) {
  const denied = await checkPermission(req, 'agents', 'manage')
  if (denied) return denied
  try {
    const code = requireAgentCode((await params).code)
    const data = await directoryBody(req, NewAgentLineSchema)
    const [line] = await query<{id:string}>(`INSERT INTO agent_contact_lines(agent_code,linea,variant,label,phone,is_active)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,[code,data.linea,data.variant,data.label,data.phone,data.is_active])
    void audit({req,action:'create',resource:'agent_lines',resource_id:line.id,metadata:{code,linea:data.linea,variant:data.variant}})
    return Response.json({ok:true,id:line.id},{status:201})
  } catch(error) { return directoryError(error) }
}
