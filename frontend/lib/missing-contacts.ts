import { contactAccountKey } from './contact-account-identity'
import type { Client } from 'pg'
import type { SessionUser } from './auth'
import { getLongRunningClient, pool } from './db'
import { missingContactSnapshot, filterMissingContactSnapshot } from './missing-contact-snapshot'
import { dashboardAgents, platformCanonicalAgentSql, movementDateSql, movementPeriodSql } from './dashboard-scope'
import { SYNC_PLATFORMS } from './casino-agents'
import { normalizeMissingContactPhone } from './missing-contact-files'
import type { MissingContact, MissingContactImportRow, MissingContactImportResult } from './missing-contact-types'

type Access = Pick<SessionUser, 'role' | 'user_id' | 'allowed_agents'>
const today = "(CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')::date"
const canonical = platformCanonicalAgentSql('p')

// Keep account matching identical to segmentation, including legacy contacts
// with names only and ambiguous usernames on different platforms.
const accountsSql = `
  players AS MATERIALIZED (
    SELECT p.username_lower AS username, p.platform, p.agente AS source_agent,
      ${canonical} AS agent, p.fecha_ultima, cp.first_seen_at
    FROM casino_segmentation_players p
    LEFT JOIN casino_players cp ON cp.platform=p.platform AND cp.username_lower=p.username_lower
    WHERE p.platform = ANY($1::text[]) AND p.username_lower <> lower(trim(p.agente))
      AND ${canonical} = ANY($2::text[])
  ), known_links AS MATERIALIZED (
    SELECT DISTINCT l.platform, l.username_lower AS username, c.id, c.phone_number
    FROM casino_contact_account_links l JOIN contacts c ON c.id=l.contact_id
    WHERE c.deleted_at IS NULL AND c.phone_number ~ '^\\+[1-9][0-9]{9,14}$'
  )`

export function missingContactAgents(user: Access): string[] {
  const all = dashboardAgents('consolidado')
  // These accounts do not yet have a contact assignment. Non-admins need an
  // explicit agent scope; contact-only grants cannot authorize new accounts.
  return user.role === 'admin' ? all : all.filter(a => (user.allowed_agents ?? []).includes(a))
}

async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = await getLongRunningClient()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL statement_timeout = '60s'")
    await client.query("SET LOCAL lock_timeout = '5s'")
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { await client.end() }
}

async function scopedAgents(client: Pick<Client, 'query'>, user: Access) {
  const agents = missingContactAgents(user)
  if (user.role === 'admin' || !agents.length) return agents
  const { rows } = await client.query('SELECT EXISTS(SELECT 1 FROM operator_contact_visibility WHERE operator_id=$1) AS restricted', [user.user_id])
  return rows[0]?.restricted ? [] : agents
}

export function readMissingContactFilters(params: URLSearchParams) {
  const months = Number(params.get('months') ?? 6)
  const page = Number(params.get('page') ?? 1)
  const platform = params.get('platform') ?? ''
  const agent = (params.get('agent') ?? '').trim().toLowerCase()
  if (![1, 3, 6, 12, 24, 0].includes(months)) throw new Error('Período inválido.')
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new Error('Página inválida.')
  if (platform && !SYNC_PLATFORMS.includes(platform as typeof SYNC_PLATFORMS[number])) throw new Error('Plataforma inválida.')
  if (agent && !dashboardAgents('consolidado').includes(agent)) throw new Error('Agente inválido.')
  return { months, page, platform, agent, q: (params.get('q') ?? '').trim().slice(0, 100), includeNew: params.get('include_new') !== 'false' }
}

export async function loadMissingContactSnapshot(): Promise<MissingContact[]> {
  return withClient(async client => {
    const { rows } = await client.query(`WITH ${accountsSql},
      bounds AS (SELECT CASE WHEN $3::int=0 THEN '-infinity'::date
        ELSE (${today} - make_interval(months => $3::int))::date END AS since),
      movements AS MATERIALIZED (
        SELECT t.platform, lower(t.username) AS username, max(${movementDateSql('t')}) AS last_movement
        FROM casino_transactions t CROSS JOIN bounds b
        WHERE t.platform = ANY($1::text[]) AND t.tipo IN ('carga','retiro')
          AND ${movementPeriodSql('t', 'b.since', today)}
        GROUP BY t.platform,lower(t.username)
      ), pending AS MATERIALIZED (
        SELECT p.username,p.platform,p.agent,p.source_agent,
          GREATEST(m.last_movement, CASE WHEN p.fecha_ultima BETWEEN b.since AND ${today} THEN p.fecha_ultima END)::text AS last_movement,
          p.first_seen_at
        FROM players p CROSS JOIN bounds b
        LEFT JOIN movements m ON m.platform=p.platform AND m.username=p.username
        WHERE ($4::text='' OR strpos(p.username,lower($4))>0)
          AND (m.last_movement IS NOT NULL OR p.fecha_ultima BETWEEN b.since AND ${today}
            OR ($5::boolean AND (p.first_seen_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date BETWEEN b.since AND ${today}))
          AND NOT EXISTS(SELECT 1 FROM known_links l WHERE l.platform=p.platform AND l.username=p.username)
      ), page AS (
        SELECT * FROM pending ORDER BY last_movement DESC NULLS LAST, first_seen_at DESC NULLS LAST, platform, username
        LIMIT $6 OFFSET $7
      ) SELECT (SELECT count(*)::int FROM pending) AS total,
        COALESCE((SELECT jsonb_agg(page) FROM page),'[]'::jsonb) AS users`,
    [[...SYNC_PLATFORMS], dashboardAgents('consolidado'), 0, '', true, null, 0])
    return rows[0].users as MissingContact[]
  })
}

export async function startMissingContactRefresh() {
  // Warm the permission-check connection too, before the first authenticated read.
  await Promise.all([pool.query('SELECT 1'), missingContactSnapshot.start(loadMissingContactSnapshot)])
}

export async function listMissingContacts(user: Access, filters: ReturnType<typeof readMissingContactFilters>, download = false) {
  // Reuse the ordinary pool only for fresh permission scope checks. Heavy work
  // runs once per minute, never once per user, filter, page or export.
  const agents = user.role === 'admin' ? missingContactAgents(user) : await scopedAgents(pool, user)
  if (!agents.length || (filters.agent && !agents.includes(filters.agent))) return { users: [] as MissingContact[], total: 0, agents }
  return filterMissingContactSnapshot(await missingContactSnapshot.read(loadMissingContactSnapshot), agents, filters, download)
}

export function validateMissingContactRows(input: unknown): MissingContactImportRow[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100000) throw new Error('Cargá entre 1 y 100.000 filas por archivo.')
  return input.map((r, i) => {
    if (!r || typeof r !== 'object') throw new Error(`Fila ${i + 2} inválida.`)
    for (const key of ['username', 'platform', 'agent', 'phone', 'name']) {
      if (typeof r[key] !== 'string' || r[key].length > (key === 'phone' ? 100 : 150)) throw new Error(`Campo ${key} inválido en la fila ${i + 2}.`)
    }
    return { row: Number.isSafeInteger(r.row) && r.row >= 2 ? r.row : i + 2,
      username: r.username.trim().toLowerCase(), platform: r.platform.trim().toLowerCase(),
      agent: r.agent.trim().toLowerCase(), name: r.name.trim().slice(0, 100), phone: r.phone.trim() }
  })
}

export async function importMissingContacts(user: Access, input: MissingContactImportRow[], dryRun: boolean): Promise<MissingContactImportResult> {
  let linkedAccounts: MissingContactImportRow[] = []
  const imported = await withClient(async client => {
    // Serialize this import workflow so two returned sheets cannot attach the
    // same platform account to different phones concurrently.
    if (!dryRun) await client.query("SELECT pg_advisory_xact_lock(hashtextextended('missing-contact-import',0))")
    const agents = await scopedAgents(client, user)
    const result: MissingContactImportResult = { total: input.length, ready: 0, inserted: 0, linked: 0, unchanged: 0, blank: 0, errors: [], dryRun }
    const { rows: accounts } = await client.query(`WITH ${accountsSql},
      linked AS (SELECT platform,username,jsonb_agg(phone_number) AS phones FROM known_links GROUP BY platform,username)
      SELECT p.*, COALESCE(l.phones,'[]'::jsonb) AS phones
      FROM players p LEFT JOIN linked l USING(platform,username)
      WHERE EXISTS (SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS i(platform text,username text)
        WHERE i.platform=p.platform AND i.username=p.username)`, [[...SYNC_PLATFORMS], agents, JSON.stringify(input)])
    const key = (r: { platform: string; username: string }) => JSON.stringify([r.platform, r.username])
    const byAccount = new Map(accounts.map(a => [key(a), a]))
    const seen = new Map<string, Set<string>>()
    for (const row of input) {
      if (!row.phone) continue
      const phones = seen.get(contactAccountKey(row.agent,row.username,'')) ?? new Set<string>()
      phones.add(normalizeMissingContactPhone(row.phone) ?? row.phone)
      seen.set(contactAccountKey(row.agent,row.username,''), phones)
    }
    const prepared: Array<MissingContactImportRow & { phone: string }> = []
    const processed = new Set<string>()
    for (const row of input) {
      const error = (message: string) => result.errors.push({ row: row.row, username: row.username, error: message })
      if (!row.phone) { result.blank++; continue }
      const phone = normalizeMissingContactPhone(row.phone)
      const account = byAccount.get(key(row))
      if (!phone) { error('Celular inválido. Incluí código de país, por ejemplo +5491123456789.'); continue }
      if ((seen.get(contactAccountKey(row.agent,row.username,''))?.size ?? 0) > 1) { error('El mismo usuario tiene celulares diferentes en el archivo.'); continue }
      if (!account || account.agent !== row.agent) { error('No se encontró la cuenta en ese agente o no tenés acceso. Descargá una planilla actualizada.'); continue }
      if (account.phones.length && !account.phones.every((p: string) => p === phone)) { error('La cuenta ya está vinculada a otro celular. Revisala en Contactos.'); continue }
      if (account.phones.length || processed.has(key(row))) { result.unchanged++; continue }
      processed.add(key(row))
      prepared.push({ ...row, phone })
    }
    const keyed = prepared.map(row=>({...row,identity_key:contactAccountKey(row.agent,row.username,row.phone)}))
    const { rows: existing } = await client.query(`SELECT id,identity_key,panel,phone_number,deleted_at FROM contacts
      WHERE identity_key=ANY($1::text[]) ${dryRun?'':'FOR UPDATE'}`,[keyed.map(r=>r.identity_key)])
    const byKey = new Map(existing.map(c=>[c.identity_key,c]))
    const approved = keyed.filter(row=>{
      const contact=byKey.get(row.identity_key)
      if(contact && contact.phone_number!==row.phone) { result.errors.push({row:row.row,username:row.username,error:'La cuenta ya tiene otro celular. Revisala en Contactos.'});return false }
      if(contact?.deleted_at || (contact && user.role!=='admin' && !agents.includes(contact.panel))) {
        result.errors.push({row:row.row,username:row.username,error:'La cuenta está eliminada o fuera de tu acceso. Requiere revisión de un administrador.'})
        return false
      }
      return true
    })
    result.ready = approved.length
    if (dryRun || !approved.length) return result
    const { rows: saved } = await client.query(`WITH grouped AS (
      SELECT identity_key,username,agent,phone,min(NULLIF(name,'')) AS name,
        jsonb_agg(DISTINCT jsonb_build_object('username',username,'platform',platform,'panel',agent)) accounts
      FROM jsonb_to_recordset($1::jsonb) i(username text,platform text,agent text,name text,phone text,identity_key text)
      GROUP BY identity_key,username,agent,phone
    ) INSERT INTO contacts(external_id,phone_number,first_name,panel,panels_assigned,casino_accounts,account_username,identity_key,status,platform_source)
      SELECT gen_random_uuid()::text,phone,COALESCE(name,username),agent,ARRAY[agent],accounts,username,identity_key,'active','missing-phone-import' FROM grouped
      ON CONFLICT(identity_key) DO UPDATE SET casino_accounts=(SELECT jsonb_agg(DISTINCT a) FROM jsonb_array_elements(contacts.casino_accounts||EXCLUDED.casino_accounts) a),updated_at=now()
      WHERE contacts.deleted_at IS NULL AND ($2::boolean OR contacts.panel=ANY($3::text[]))
      RETURNING identity_key,(xmax=0) AS inserted`,[JSON.stringify(approved),user.role==='admin',agents])
    const savedKeys = new Set(saved.map(r=>r.identity_key))
    if(approved.some(r=>!savedKeys.has(r.identity_key))) throw new Error('Una cuenta cambió durante la carga. Volvé a revisar el archivo.')
    result.inserted = saved.filter(r => r.inserted).length
    result.linked = approved.length
    linkedAccounts = approved
    return result
  })
  // Only evict after COMMIT; a failed import leaves the previous list intact.
  if (!dryRun && linkedAccounts.length) missingContactSnapshot.remove(linkedAccounts)
  return imported
}
