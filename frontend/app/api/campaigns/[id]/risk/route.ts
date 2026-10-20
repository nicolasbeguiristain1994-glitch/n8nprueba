import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser, isCampaignOwnerOrAdmin } from '@/lib/permissions'
import { isUUID } from '@/lib/validate'
import { CampaignRiskError, getCampaignRiskState, reviewCampaignRisk } from '@/lib/campaign-risk'
import { audit } from '@/lib/audit'
import { refreshCampaignMetaRisk } from '@/lib/cloud-api/meta-risk-refresh'

type Context = { params: Promise<{ id: string }> }

async function authorize(req: Request, context: Context, review: boolean) {
  const auth = await checkPermissionWithUser(req, 'campaigns', review ? 'update' : 'read')
  if (!auth.ok) return { response: auth.response }
  if (review) {
    const send = await checkPermissionWithUser(req, 'send', 'send')
    if (!send.ok) return { response: send.response }
  }
  const { id } = await context.params
  if (!isUUID(id)) return { response: NextResponse.json({ error: 'Identificador inválido' }, { status: 400 }) }
  const [campaign] = await query<{ owned_by: string | null }>('SELECT owned_by FROM campaigns WHERE id=$1', [id])
  if (!campaign) return { response: NextResponse.json({ error: 'Campaña no encontrada' }, { status: 404 }) }
  if (!isCampaignOwnerOrAdmin(auth.user, campaign.owned_by))
    return { response: NextResponse.json({ error: 'No tenés acceso a esta campaña' }, { status: 403 }) }
  return { id, user: auth.user }
}

export async function GET(req: Request, context: Context) {
  try {
    const auth = await authorize(req, context, false)
    if (auth.response) return auth.response
    try { await refreshCampaignMetaRisk(auth.id!) }
    catch (error) { if (!(error instanceof CampaignRiskError)) throw error }
    return NextResponse.json(await getCampaignRiskState(auth.id!), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[GET /campaigns/risk]', error instanceof Error ? error.message : error)
    return NextResponse.json({ error: 'No se pudo consultar la protección de la campaña' }, { status: 500 })
  }
}

export async function POST(req: Request, context: Context) {
  try {
    const auth = await authorize(req, context, true)
    if (auth.response) return auth.response
    const body = await req.json().catch(() => null)
    const note = typeof body?.note === 'string' ? body.note.trim() : ''
    const incidentIds: unknown = body?.incidentIds
    if (note.length < 10 || note.length > 2000 || !Array.isArray(incidentIds) || !incidentIds.length ||
        incidentIds.length > 100 || incidentIds.some(id => typeof id !== 'string' || !isUUID(id)) ||
        new Set(incidentIds).size !== incidentIds.length) {
      return NextResponse.json({ error: 'Describí la revisión (10 a 2000 caracteres) e incluí las alertas que revisaste' }, { status: 400 })
    }
    await reviewCampaignRisk({ campaignId: auth.id!, userId: auth.user!.user_id, note, incidentIds })
    void audit({ req, action: 'update', resource: 'campaigns', resource_id: auth.id,
      metadata: { action: 'review_campaign_risk', incident_ids: incidentIds } })
    // Reviewing a hold never starts a processor or changes recipients.
    return NextResponse.json({ ok: true, message: 'Revisión registrada. No se inició ningún envío; reanudá la campaña por separado cuando corresponda.' })
  } catch (error) {
    if (error instanceof CampaignRiskError)
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    console.error('[POST /campaigns/risk]', error instanceof Error ? error.message : error)
    return NextResponse.json({ error: 'No se pudo registrar la revisión. La protección se mantiene.' }, { status: 500 })
  }
}
