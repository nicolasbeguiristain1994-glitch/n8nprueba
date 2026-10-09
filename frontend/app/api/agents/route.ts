import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { directoryBody, directoryError, NewAgentSchema } from '@/lib/agent-directory'

export async function GET(req: Request) {
  const denied = await checkPermission(req, 'agents', 'manage')
  if (denied) return denied
  try {
    const agents = await query(`SELECT a.code,a.name,COALESCE(
      jsonb_agg(l ORDER BY l.linea,l.variant) FILTER (WHERE l.id IS NOT NULL),'[]'::jsonb) AS lines
      FROM crm_agents a LEFT JOIN agent_contact_lines l ON l.agent_code=a.code
      GROUP BY a.code,a.name ORDER BY lower(a.name),a.code`)
    return Response.json({ agents })
  } catch (error) { return directoryError(error) }
}
export async function POST(req: Request) {
  const denied = await checkPermission(req, 'agents', 'manage')
  if (denied) return denied
  try {
    const data = await directoryBody(req, NewAgentSchema)
    await query('INSERT INTO crm_agents(code,name) VALUES($1,$2)', [data.code,data.name])
    void audit({req, action:'create', resource:'agents', metadata:{code:data.code}})
    return Response.json({ok:true,code:data.code}, {status:201})
  } catch (error) { return directoryError(error) }
}
