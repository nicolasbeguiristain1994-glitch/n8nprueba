// POST /api/distributor/assign
//
// Advisory or persisting line + proxy assignment.
// Returns the top N scored lines with their resolved proxies.
//
// Body (all optional):
//   campaignId?    string  — for audit log context
//   preferCountry? string  — ISO 3166-1 alpha-2 (e.g. "AR")
//   topN?          number  — how many results to return (default 1, max 10)
//   persist?       boolean — when true, writes proxy assignments to DB (default false)
//
// Requires: lines:read (advisory) — no extra role needed.
// Persist mode additionally requires lines:update (validated below).

import { NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { intelligentAssign } from '@/lib/distributor'
import { isUUID, clampStr } from '@/lib/validate'

export async function POST(req: Request) {
  const auth = await checkPermissionWithUser(req, 'lines', 'read')
  if (!auth.ok) return auth.response

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* empty body is fine */ }

  const persist        = body.persist === true
  const campaignId     = typeof body.campaignId === 'string' && isUUID(body.campaignId)
    ? body.campaignId : undefined
  const preferCountry  = clampStr(body.preferCountry, 2) ?? undefined
  const rawTopN        = typeof body.topN === 'number' ? Math.round(body.topN) : 1
  const topN           = Math.max(1, Math.min(10, rawTopN))

  // Persist mode requires update permission
  if (persist) {
    const updateAuth = await checkPermissionWithUser(req, 'lines', 'update')
    if (!updateAuth.ok) return updateAuth.response
  }

  try {
    const result = await intelligentAssign({
      campaignId,
      preferCountry,
      topN,
      persist,
      requestedBy: auth.user.user_id,
    })

    void audit({
      req,
      action:    persist ? 'distributor.assign.persist' : 'distributor.assign.preview',
      resource:  'lines',
      status:    'success',
      metadata:  {
        topN,
        persist,
        preferCountry: preferCountry ?? null,
        totalCandidates: result.totalCandidates,
        filteredOut:     result.filteredOut,
        resultsCount:    result.results.length,
        lineIds:         result.results.map(r => r.line.id),
      },
    })

    return NextResponse.json(result)
  } catch (e) {
    console.error('[/api/distributor/assign POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
