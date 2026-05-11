#!/usr/bin/env tsx
// Worker de BullMQ para procesar la cola de mensajes de Cloud API.
// Ejecutar como proceso separado: npx tsx scripts/workers/cloud-message-worker.ts
//
// Este worker NO debe correr dentro del proceso de Next.js.
// En producción: usar PM2 o un servicio systemd separado.

import 'dotenv/config'
import { Worker, type Job }          from 'bullmq'
import { getTokenForNumber }         from '../../frontend/lib/cloud-api/token-store'
import { moveToDeadLetter }          from '../../frontend/lib/cloud-api/message-queue'
import { isRetryable }               from '../../frontend/lib/cloud-api/errors'
import { waitForRateLimit }          from '../../frontend/lib/cloud-api/rate-limiter'
import { MetaHttpGateway }           from '../../frontend/lib/cloud-api/infrastructure/meta-http.gateway'
import { messageRepository }         from '../../frontend/lib/cloud-api/repositories/conversation.repository'
import { createLogger }              from '../../frontend/lib/cloud-api/infrastructure/logger'
import { createCorrelationId }       from '../../frontend/lib/cloud-api/correlation'
import { META_API_VERSION }          from '../../frontend/lib/cloud-api/types/domain'
import type { QueuedMessage }        from '../../frontend/lib/cloud-api/types'

const QUEUE_NAME  = 'cloud-messages'
const CONCURRENCY = 5

const lifecycleLog = createLogger({ correlationId: 'system', operation: 'worker_lifecycle' })

const connection = {
  host:     new URL(process.env.REDIS_URL ?? 'redis://localhost:6379').hostname,
  port:     parseInt(new URL(process.env.REDIS_URL ?? 'redis://localhost:6379').port || '6379', 10),
  password: new URL(process.env.REDIS_URL ?? 'redis://localhost:6379').password || undefined,
}

const worker = new Worker<QueuedMessage>(
  QUEUE_NAME,
  async (job: Job<QueuedMessage>) => {
    const msg           = job.data
    const correlationId = createCorrelationId()
    const log           = createLogger({ correlationId, phoneNumberId: msg.phoneNumberId, operation: 'worker_job' })

    log.logInfo('job started', { jobId: job.id, to: msg.to })

    await waitForRateLimit(msg.phoneNumberId, 3000)

    const accessToken = await getTokenForNumber(msg.phoneNumberId)
    const gateway     = new MetaHttpGateway(accessToken, {
      circuitBreakerKey: `worker:${msg.phoneNumberId}`,
      timeoutMs:         15_000,
    })

    const payload = {
      ...msg.payload,
      messaging_product: 'whatsapp',
      recipient_type:    'individual',
      to:                msg.to,
    }

    let responseData: { messages?: Array<{ id: string }> }
    try {
      responseData = await gateway.post<{ messages: Array<{ id: string }> }>(
        `/${META_API_VERSION}/${msg.phoneNumberId}/messages`,
        payload,
      )
    } catch (err) {
      const errorCode = (err as { code?: number }).code ?? 0
      log.logError('send failed', err, { jobId: job.id })
      await messageRepository.markError(
        msg.messageId, errorCode,
        String((err as { type?: string }).type ?? ''),
        String(err),
      )
      throw err
    }

    const wamid = responseData.messages![0].id
    await messageRepository.markSent(msg.messageId, wamid)
    log.logInfo('job done', { jobId: job.id, wamid })
    return { wamid, status: 'sent' }
  },
  {
    connection,
    concurrency: CONCURRENCY,
    limiter: {
      max:      20,   // BullMQ aplica el rate limit de Coexistence (20 msg/s por número)
      duration: 1000,
    },
  }
)

// ─── Event handlers ───────────────────────────────────────────────────────────

worker.on('completed', (job) => {
  lifecycleLog.logInfo('job completed', { jobId: job.id })
})

worker.on('failed', async (job, err) => {
  if (!job) return
  const msg       = job.data
  const maxFailed = (job.opts.attempts ?? 3) - 1

  lifecycleLog.logError('job failed', err, {
    jobId: job.id, attempt: job.attemptsMade, maxAttempts: job.opts.attempts,
  })

  if (!isRetryable(err) || job.attemptsMade >= maxFailed) {
    await moveToDeadLetter(
      msg, err.message,
      (err as Error & { metaCode?: number }).metaCode,
    ).catch(e => lifecycleLog.logError('DLQ error', e))
  }
})

worker.on('error', (err) => {
  lifecycleLog.logError('worker error', err)
})

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown() {
  lifecycleLog.logInfo('shutting down')
  await worker.close()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT',  shutdown)

lifecycleLog.logInfo('started', {
  concurrency: CONCURRENCY,
  redis: process.env.REDIS_URL ?? 'redis://localhost:6379',
})
