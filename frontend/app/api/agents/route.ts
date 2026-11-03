import { agentScope } from '@/lib/agent-scope'
import { query } from '@/lib/db'
import { checkPermission, checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { directoryBody, directoryError, NewAgentSchema } from '@/lib/agent-directory'

export async function GET(req: Request) {
  const optionsOnly = new URL(req.url).searchParams.get('purpose') === 'automations'
  const auth = await checkPermissionWithUser(req, optionsOnly ? 'automations' : 'agents', 'read')
  if (!auth.ok) return auth.response
  try {
    const agents = await query(`SELECT a.code,a.name,a.delivery_mode,a.phone_format,COALESCE(
      jsonb_agg(l ORDER BY l.linea,l.variant) FILTER (WHERE l.id IS NOT NULL),'[]'::jsonb) AS lines
      FROM crm_agents a LEFT JOIN agent_contact_lines l ON l.agent_code=a.code
      WHERE ($1::text[] IS NULL OR a.code=ANY($1))
      GROUP BY a.code,a.name,a.delivery_mode,a.phone_format ORDER BY lower(a.name),a.code`, [agentScope(auth.user)])
    return Response.json({ agents: optionsOnly ? agents.map(a => ({code:a.code,name:a.name,delivery_mode:a.delivery_mode,phone_format:a.phone_format})) : agents })
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
