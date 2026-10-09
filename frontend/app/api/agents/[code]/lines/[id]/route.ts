import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { isUUID } from '@/lib/validate'
import { AgentLineDetailsSchema, directoryBody, directoryError, requireAgentCode } from '@/lib/agent-directory'
export async function PATCH(req: Request, {params}: {params: Promise<{code:string;id:string}>}) {
  const denied = await checkPermission(req, 'agents', 'manage')
  if (denied) return denied
  try {
    const values = await params, code = requireAgentCode(values.code)
    if (!isUUID(values.id)) return Response.json({error:'Línea inválida'},{status:400})
    const data = await directoryBody(req, AgentLineDetailsSchema)
    const rows = await query(`UPDATE agent_contact_lines SET label=$3,phone=$4,is_active=$5,updated_at=NOW()
      WHERE agent_code=$1 AND id=$2 RETURNING id`,[code,values.id,data.label,data.phone,data.is_active])
    if (!rows.length) return Response.json({error:'Línea no encontrada'},{status:404})
    void audit({req,action:'update',resource:'agent_lines',resource_id:values.id,metadata:{code,is_active:data.is_active}})
    return Response.json({ok:true})
  } catch(error) { return directoryError(error) }
}
