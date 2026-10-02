import { NextRequest, NextResponse } from 'next/server'
import { checkPermission }           from '@/lib/permissions'
import { cloudMetrics }              from '@/lib/cloud-api/infrastructure/metrics'
import { getAllBreakerStatuses }      from '@/lib/cloud-api/infrastructure/circuit-breaker'
import { getQueueStats }             from '@/lib/cloud-api/message-queue'

// GET /api/cloud/metrics
// Retorna métricas en formato JSON o texto Prometheus según el header Accept.
// Protegido: requiere permiso de admin.

export async function GET(req: NextRequest) {
  const err = await checkPermission(req, 'settings', 'read')
  if (err) return err

  const accept = req.headers.get('accept') ?? ''

  // Prometheus scrape
  if (accept.includes('text/plain') || req.nextUrl.searchParams.has('format') && req.nextUrl.searchParams.get('format') === 'prometheus') {
    return new NextResponse(cloudMetrics.toPrometheusText(), {
      status:  200,
      headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' },
    })
  }

  // JSON (dashboards internos)
  const [queueStats, breakerStatuses] = await Promise.all([
    process.env.CLOUD_MESSAGE_WORKER_ENABLED === 'true' ? getQueueStats().catch(() => ({ unavailable: true })) : Promise.resolve({ enabled: false }),
    Promise.resolve(getAllBreakerStatuses()),
  ])

  return NextResponse.json({
    metrics:         cloudMetrics.toJSON(),
    queue:           queueStats,
    circuitBreakers: breakerStatuses,
    timestamp:       new Date().toISOString(),
  })
}
