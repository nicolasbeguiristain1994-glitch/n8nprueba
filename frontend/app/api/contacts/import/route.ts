import { canonicalContactAgent, contactAccountKey } from '@/lib/contact-account-identity'
import { contactScope, canAssignPanels, grantCreatedContacts } from '@/lib/contact-visibility'
import { NextRequest, NextResponse } from 'next/server'
import { getLongRunningClient } from '@/lib/db'
import { prepareSegmentation, applySegmentation, activityPreservationPlatforms } from '@/lib/casino-segmentation'
import { isE164 } from '@/lib/validate'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'create')
  if (!auth.ok) return auth.response

  let body: {
    contacts?:      Array<{ phone: string; name?: string; segment?: string; casino_username?: string }>
    row_offset?:    number
    panel?:         string
    panels?:        string[]
    linea?:         number
    linea_sub?:     string
    skip_existing?: boolean
    conflict_mode?: 'update' | 'panels_only' | 'skip'
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { contacts, panel, panels, linea, skip_existing = false, conflict_mode, row_offset = 0 } = body
  if (!Number.isSafeInteger(row_offset) || row_offset < 0) return NextResponse.json({error:'Posición de archivo inválida'},{status:400})
  // conflict_mode takes precedence over legacy skip_existing
  const resolvedMode: 'update' | 'panels_only' | 'skip' =
    conflict_mode ?? (skip_existing ? 'skip' : 'update')
  if (!['update','panels_only','skip'].includes(resolvedMode)) return NextResponse.json({error: 'Modo inválido'}, {status: 400})
  if (!contacts?.length) return NextResponse.json({ error: 'No contacts provided' }, { status: 400 })
  if (!Array.isArray(contacts) || contacts.length > 10_000) {
    return NextResponse.json({ error: 'contacts debe ser un array de máximo 10.000 filas por chunk' }, { status: 400 })
  }

  // panels param takes precedence over legacy panel param
  const panelsRaw = (panels && panels.length > 0)
    ? panels.map(p => canonicalContactAgent(p)!).filter(Boolean)
    : panel?.trim().toLowerCase() ? [canonicalContactAgent(panel)!] : []

  if (panelsRaw.length && !canAssignPanels(auth.user, panelsRaw)) {
    return NextResponse.json({error: 'Agente fuera de tu alcance'}, {status: 403})
  }
  const lineaValue = linea ? Number(linea) : null
  if (lineaValue !== null && (!Number.isInteger(lineaValue) || lineaValue < 1 || lineaValue > 100)) {
    return NextResponse.json({ error: 'Línea inválida (1-100)' }, { status: 400 })
  }
  // Legacy A/B/C input is accepted but stored as the base line.
  const lineaSubValue = null

  // Keep different phones until existing records have been resolved. Historical
  // accounts may legitimately have one record for each phone.
  const seen = new Set<string>()
  let invalidCount = 0
  let normalized: Array<{phone:string;name:string|null;segment:string|null;casino_username:string|null;panel:string|null;identity_key:string;input_key:string;position:number}> = []
  for (const [index, c] of contacts.entries()) {
    const rawPhone = (c.phone || '').toString().trim().replace(/\s/g, '')
    if (!isE164(rawPhone)) { invalidCount++; continue }
    const username = (c.casino_username || c.name || '').trim().toLowerCase().slice(0,100) || null
    const segment = (c.segment || '').trim().toLowerCase()
    for (const agent of [...new Set(panelsRaw.length ? panelsRaw : [null])]) {
      const key = contactAccountKey(agent,username,rawPhone)
      const inputKey = JSON.stringify([key, rawPhone])
      if (seen.has(inputKey)) continue
      seen.add(inputKey)
      normalized.push({phone:rawPhone,name:c.name?.trim().slice(0,100)||username,
        segment:['casual','regular','super_vip','vip_alto','vip_medio','vip','whale','bajo','medio'].includes(segment)?segment:null,
        casino_username:username,panel:agent,identity_key:key,input_key:inputKey,position:row_offset+index+1})
    }
  }

  let skipped = Math.max(0, contacts.length - normalized.length - invalidCount)

  if (normalized.length === 0) {
    return NextResponse.json({ inserted: 0, updated: 0, skipped: skipped + invalidCount, invalid: invalidCount, total: contacts.length })
  }

  // Single bulk upsert via jsonb_to_recordset — N individual queries → 1 query.
  // xmax = 0 means the row was inserted; non-zero means updated (Postgres internal).
  const client = await getLongRunningClient()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL TIME ZONE 'America/Argentina/Buenos_Aires'")
    await client.query("SET LOCAL statement_timeout='60s'")
    await client.query("SELECT pg_advisory_xact_lock(hashtext('casino-segmentation'))")
    // A line-only assignment can reuse the account already present in the file.
    // Never pick an arbitrary agent when the same phone/username has several accounts.
    if (!panelsRaw.length && lineaValue !== null) {
      const access = contactScope(auth.user, 1, 'c')
      const { rows: matches } = await client.query<{
        input_key: string; identity_key: string; panel: string | null;
        account_username: string | null; visible: boolean
      }>(`SELECT i.input_key,c.identity_key,c.panel,c.account_username,
          (${access.sql}) AS visible
        FROM contacts c JOIN jsonb_to_recordset($1::jsonb)
          AS i(phone text,casino_username text,input_key text)
          ON c.phone_number=i.phone AND (i.casino_username IS NULL
            OR c.account_username=i.casino_username
            OR (c.account_username IS NULL AND lower(trim(c.first_name))=i.casino_username)
            OR (c.identity_key LIKE 'legacy:%' AND EXISTS (SELECT 1 FROM jsonb_array_elements(c.casino_accounts) a
              WHERE lower(trim(a->>'username'))=i.casino_username)))
        WHERE c.deleted_at IS NULL FOR UPDATE OF c`, [JSON.stringify(normalized), ...access.params])
      if (matches.some(c => !c.visible)) throw NextResponse.json({error:'La importación incluye contactos fuera de tu alcance. No se guardaron cambios.'},{status:403})
      const byInput = new Map<string, typeof matches[number]>()
      for (const match of matches) {
        if (byInput.has(match.input_key)) throw NextResponse.json({error:'Un teléfono y usuario coincide con varias cuentas. Elegí el agente para asignar la línea; no se guardaron cambios.'},{status:409})
        byInput.set(match.input_key, match)
      }
      normalized = normalized.map(input => {
        const match = byInput.get(input.input_key)
        return match ? { ...input, identity_key: match.identity_key,
          panel: match.panel, casino_username: match.account_username ?? input.casino_username } : input
      })
    }
    // Historical records can retain several account aliases. The file's exact
    // phone disambiguates which record receives the line without merging phones.
    const legacyScope = contactScope(auth.user, 1, 'c')
    const { rows: candidates } = await client.query<{
      input_key: string; identity_key: string; phone_number: string;
      panel: string | null; account_username: string | null; visible: boolean
    }>(`WITH input AS MATERIALIZED (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS i(panel text,casino_username text,identity_key text)
      ), matches AS (
        SELECT i.identity_key AS input_key,c.id FROM contacts c JOIN input i ON c.identity_key=i.identity_key
        UNION
        SELECT i.identity_key,c.id FROM contacts c
        CROSS JOIN LATERAL jsonb_array_elements(c.casino_accounts) a
        JOIN input i ON contact_agent_key(a->>'panel')=i.panel AND lower(trim(a->>'username'))=i.casino_username
        WHERE c.identity_key LIKE 'legacy:%'
      ) SELECT m.input_key,c.identity_key,c.phone_number,c.panel,c.account_username,
        (${legacyScope.sql}) AS visible
      FROM matches m JOIN contacts c ON c.id=m.id
      FOR UPDATE OF c`, [JSON.stringify(normalized), ...legacyScope.params])
    const candidatesByInput = new Map<string, typeof candidates>()
    for (const candidate of candidates) {
      const group = candidatesByInput.get(candidate.input_key) ?? []
      group.push(candidate); candidatesByInput.set(candidate.input_key, group)
    }
    const resolvedAccounts = new Map<string, typeof normalized[number]>()
    for (const input of normalized) {
      const group = candidatesByInput.get(input.identity_key) ?? []
      let account = input
      if (group.some(c => c.identity_key.startsWith('legacy:'))) {
        const exact = group.filter(c => c.phone_number === input.phone)
        if (lineaValue === null || exact.length !== 1) {
          throw NextResponse.json({error:`No se pudo identificar una sola cuenta histórica para ${input.casino_username ?? input.phone}. Revisá el agente y el teléfono de esa fila; no se guardaron cambios.`},{status:409})
        }
        const match = exact[0]
        if (!match.visible) throw NextResponse.json({error:'La importación incluye contactos fuera de tu alcance. No se guardaron cambios.'},{status:403})
        account = { ...input, identity_key: match.identity_key, panel: match.panel,
          casino_username: match.account_username ?? input.casino_username }
      }
      const previous = resolvedAccounts.get(account.identity_key)
      if (previous && previous.phone !== account.phone) {
        const existing = group.some(c => c.identity_key === account.identity_key)
        // These modes never change an existing phone. Assign the line once, without
        // selecting one of the file's conflicting phone values or creating a copy.
        if (existing && resolvedMode !== 'update') continue
        const advice = existing && lineaValue !== null
          ? ' Para moverla sin cambiar el número, elegí «Conservar datos existentes; actualizar solo la línea».'
          : ' Corregí el usuario o dejá un solo teléfono para esa cuenta.'
        throw NextResponse.json({error:`La cuenta «${input.casino_username ?? input.phone}» tiene teléfonos distintos en los contactos ${previous.position} (${previous.phone}) y ${input.position} (${input.phone}) del archivo.${advice} No se guardaron cambios.`},{status:409})
      }
      resolvedAccounts.set(account.identity_key, account)
    }
    normalized = [...resolvedAccounts.values()]
    skipped = Math.max(0, contacts.length - normalized.length - invalidCount)
    if (!canAssignPanels(auth.user, normalized.map(c => c.panel))) {
      throw NextResponse.json({error:'Elegí un agente dentro de tu alcance para los contactos nuevos. No se guardaron cambios.'},{status:403})
    }
    // Reject the whole chunk before modifying any row. Lock existing contacts
    // so a concurrent panel change cannot evade the conflict predicate.
    const preflight = contactScope(auth.user, 1)
    const existing = await client.query<{id: string; visible: boolean}>(`SELECT id, (${preflight.sql}) AS visible
      FROM contacts WHERE identity_key=ANY($1::text[]) FOR UPDATE`, [normalized.map(c => c.identity_key), ...preflight.params])
    if (existing.rows.some(c => !c.visible)) throw NextResponse.json({error: 'La importación incluye contactos fuera de tu alcance. No se guardaron cambios.'}, {status: 403})
    const updateExisting = resolvedMode !== 'skip' || lineaValue !== null
    const scope = contactScope(auth.user, 3)
    const { rows: [row] } = await client.query<{inserted:string;updated:string;ids:string[];created_ids:string[]}>(`
      WITH input AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb)
          AS x(phone text,name text,segment text,casino_username text,panel text,identity_key text)
      ), upserted AS (
        INSERT INTO contacts(external_id,phone_number,first_name,segment,panel,panels_assigned,
          casino_accounts,account_username,identity_key,linea,linea_sub,status,opt_in_marketing,opt_in_sms,platform_source)
        SELECT gen_random_uuid()::text,phone,name,segment::contact_segment,panel,
          CASE WHEN panel IS NULL THEN '{}'::text[] ELSE ARRAY[panel] END,
          CASE WHEN casino_username IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object('panel',panel,'username',casino_username)) END,
          casino_username,identity_key,$2,$3,'active',true,true,'import' FROM input
        ON CONFLICT(identity_key) DO ${!updateExisting ? 'NOTHING' : `UPDATE SET
          ${resolvedMode==='update' ? 'phone_number=EXCLUDED.phone_number,first_name=COALESCE(EXCLUDED.first_name,contacts.first_name),segment=COALESCE(EXCLUDED.segment,contacts.segment),' : ''}
          linea=COALESCE(EXCLUDED.linea,contacts.linea),
          linea_sub=CASE WHEN EXCLUDED.linea IS NOT NULL THEN EXCLUDED.linea_sub ELSE contacts.linea_sub END,
          updated_at=NOW()
          WHERE ${scope.sql}`}
        RETURNING id,xmax::text
      ) SELECT count(*) FILTER(WHERE xmax='0') AS inserted,count(*) FILTER(WHERE xmax<>'0') AS updated,
        COALESCE(array_agg(id),'{}'::uuid[]) AS ids,
        COALESCE(array_agg(id) FILTER(WHERE xmax='0'),'{}'::uuid[]) AS created_ids FROM upserted`,
      [JSON.stringify(normalized),lineaValue,lineaSubValue,...(updateExisting?scope.params:[])])

    const inserted = Number(row?.inserted || 0)
    const updated  = Number(row?.updated  || 0)

    if (updateExisting && inserted + updated !== normalized.length) {
      throw NextResponse.json({error: 'Cambió el acceso durante la importación. No se guardaron cambios.'}, {status: 403})
    }
    await grantCreatedContacts(client, auth.user, row.created_ids)
    // Preserving existing data also preserves its segmentation. A selected line
    // still moves the account; new accounts always receive their initial classification.
    const segmentationIds = resolvedMode === 'update' ? row.ids : row.created_ids
    if (segmentationIds.length) {
      await prepareSegmentation(client, { contactIds: segmentationIds })
      await applySegmentation(client, { updatePlayers: false, preserveActivityPlatforms: activityPreservationPlatforms() })
    }
    await client.query('COMMIT')

    void audit({ req, action: 'import', resource: 'contacts',
      metadata: { inserted, updated, skipped: skipped + invalidCount, invalid: invalidCount, total: contacts.length, linea: lineaValue, linea_sub: lineaSubValue } })
    return NextResponse.json({ inserted, updated, skipped: skipped + invalidCount, invalid: invalidCount, total: contacts.length })
  } catch (e) {
    await client.query('ROLLBACK')
    if (e instanceof Response) return e
    const msg = e instanceof Error ? e.message : String(e)
    const code = (e as Record<string, unknown>)?.code
    const detail = (e as Record<string, unknown>)?.detail
    console.error('[contacts/import] bulk upsert error — code:', code, '| detail:', detail, '| msg:', msg)
    return NextResponse.json({ error: 'No se pudo completar la importación y segmentación. No se guardaron cambios.' }, { status: 500 })
  } finally {
    await client.end()
  }
}
