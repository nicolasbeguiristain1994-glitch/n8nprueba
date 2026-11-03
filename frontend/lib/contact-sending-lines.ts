import { campaignRoutingHistorySQL } from './campaign-routing'
import { contactRead } from './contact-read'

export type ContactSendingLine = { id: string; name: string; phone: string | null }
export type ContactSender = { sending_line: ContactSendingLine | null; sending_line_hidden: boolean }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Same owner, normalization, precedence and history as campaign dispatch. Read only. */
export function contactSenderCTEs(destinations: string, owner: string): string {
  return `destinations AS MATERIALIZED (${destinations}),
    existing AS MATERIALIZED (
      SELECT d.phone,a.line_id FROM destinations d JOIN campaign_line_assignments a ON a.phone=d.phone
      WHERE a.owner_key=${owner}::uuid AND a.line_id IS NOT NULL
    ), missing AS MATERIALIZED (
      SELECT phone FROM destinations d WHERE NOT EXISTS(SELECT 1 FROM existing e WHERE e.phone=d.phone)
    ), ${campaignRoutingHistorySQL(`${owner}::uuid`, `${owner}::uuid`)},
    recovered AS (SELECT DISTINCT ON (phone) phone,line_id FROM history ORDER BY phone,at DESC NULLS LAST,line_id),
    resolved AS (SELECT * FROM existing UNION ALL SELECT * FROM recovered)`
}

export function contactSendingFilter(sp: URLSearchParams, audience: {sql: string; params: unknown[]}, ownerId: string) {
  const line = sp.get('sending_line') || '', mode = sp.get('sending_mode') || 'assigned'
  if (!['assigned','other'].includes(mode) || (mode === 'other' && (!line || line === 'unassigned')))
    throw new Error('Elegí una línea de envío para consultar las otras líneas')
  if (!line) return audience
  if (line !== 'unassigned' && !uuid.test(line)) throw new Error('Línea de envío inválida')
  const params = [...audience.params, ownerId], owner = `$${params.length}`
  const ctes = contactSenderCTEs(`SELECT DISTINCT regexp_replace(phone_number,'[^0-9]','','g') AS phone
    FROM contacts WHERE ${audience.sql}`, owner)
  let condition: string
  if (line === 'unassigned') {
    condition = 'NOT EXISTS (SELECT 1 FROM resolved r WHERE r.phone=d.phone)'
  } else {
    params.push(line)
    const selected = `$${params.length}::uuid`
    condition = `${selected} IN (SELECT id FROM visible) AND EXISTS (
      SELECT 1 FROM resolved r WHERE r.phone=d.phone AND r.line_id ${mode === 'other' ? '<>' : '='} ${selected})`
  }
  return {params, sql: `${audience.sql} AND regexp_replace(contacts.phone_number,'[^0-9]','','g') IN (
    WITH ${ctes} SELECT d.phone FROM destinations d WHERE ${condition})`}
}

export async function readContactSenders(rows: {id: string; phone_number: string}[], owner: string): Promise<Map<string, ContactSender>> {
  if (!rows.length) return new Map()
  const assignments = await contactRead<{phone:string; line_id:string|null; name:string|null; number:string|null; hidden:boolean}>(`
    WITH ${contactSenderCTEs("SELECT DISTINCT regexp_replace(unnest($1::text[]),'[^0-9]','','g') AS phone", '$2')}
    SELECT d.phone,wl.id AS line_id,COALESCE(NULLIF(wl.display_name,''),wl.line_key) AS name,
      wl.phone_number AS number,r.line_id IS NOT NULL AND wl.id IS NULL AS hidden
    FROM destinations d LEFT JOIN resolved r ON r.phone=d.phone
    LEFT JOIN whatsapp_lines wl ON wl.id=r.line_id AND wl.id IN (SELECT id FROM visible)`,
    [rows.map(row=>row.phone_number),owner])
  const byPhone = new Map(assignments.map(row=>[row.phone,row]))
  return new Map(rows.map(row=>{
    const sender=byPhone.get(row.phone_number.replace(/\D/g,''))
    return [row.id, {sending_line:sender?.line_id ? {id:sender.line_id,name:sender.name!,phone:sender.number} : null,
      sending_line_hidden:sender?.hidden ?? false}]
  }))
}
