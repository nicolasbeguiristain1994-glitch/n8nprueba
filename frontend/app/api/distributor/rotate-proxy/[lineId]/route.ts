// POST /api/distributor/rotate-proxy/:lineId
//
// Force a proxy rotation for the specified line.
// Finds the best available proxy (excluding the current one) and assigns it.
// If no proxy is found, releases the current assignment (proxy_id → NULL).
//
// Body (all optional):
//   campaignId?      string  — for audit log context
//   assignmentType?  'manual' | 'failover'  (default 'manual')
//
// Requires: lines:update

import { NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { rotateProxy } from '@/lib/distributor'
import { isUUID } from '@/lib/validate'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ lineId: string }> }
) {
  const auth = await checkPermissionWithUser(req, 'lines', 'update')
  if (!auth.ok) return auth.response

  const { lineId } = await params
  if (!isUUID(lineId)) {
    return NextResponse.json({ error: 'lineId must be a valid UUID' }, { status: 400 })
  }

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* empty body is fine */ }

  const campaignId = typeof body.campaignId === 'string' && isUUID(body.campaignId)
    ? body.campaignId : undefined

  const rawType = typeof body.assignmentType === 'string' ? body.assignmentType : 'manual'
  const assignmentType = (rawType === 'failover' ? 'failover' : 'manual') as 'manual' | 'failover'

  try {
    const result = await rotateProxy({
      lineId,
      campaignId,
      requestedBy:    auth.user.user_id,
      assignmentType,
    })

    void audit({
      req,
      action:     'distributor.rotate_proxy',
      resource:   'lines',
      resource_id: lineId,
      status:     'success',
      metadata:   {
        assignmentType,
        newProxyId:      result.proxy?.id ?? null,
        previousProxyId: result.line.proxy_id,
      },
    })

    return NextResponse.json({
      ok:    true,
      line:  result.line,
      proxy: result.proxy,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[/api/distributor/rotate-proxy POST]', msg)

    if (msg.includes('Line not found')) {
      return NextResponse.json({ error: 'Line not found' }, { status: 404 })
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
