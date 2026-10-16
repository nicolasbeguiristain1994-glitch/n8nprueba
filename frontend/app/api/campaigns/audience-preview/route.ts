import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { CampaignContactSelectionSchema, parseBody, handleValidationError } from '@/lib/schema'
import { resolveCampaignSelection } from '@/lib/campaign-selection-resolver'

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'campaigns', 'create')
  if (!auth.ok) return auth.response
  const contacts = await checkPermissionWithUser(req, 'contacts', 'read')
  if (!contacts.ok) return contacts.response
  const parsed = parseBody(CampaignContactSelectionSchema, await req.json().catch(() => null))
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'campaigns')
  try {
    const { summary } = await resolveCampaignSelection(parsed.data.contact_ids, auth.user)
    return NextResponse.json(summary, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (e) {
    if (e instanceof Response) return e
    console.error('[/api/campaigns/audience-preview]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'No se pudo verificar la selección. Reintentá antes de continuar.' }, { status: 500 })
  }
}
