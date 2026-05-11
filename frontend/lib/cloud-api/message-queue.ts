// Cola de mensajes para Cloud API con retry exponencial y Dead Letter Queue.
// Usa BullMQ (Redis-backed) para garantizar entrega at-least-once.
//
// NOTA: BullMQ requiere un worker separado para procesar los jobs.
// En Next.js, los workers se ejecutan fuera del proceso de la app (proceso Node separado).
// Hasta implementar el worker dedicado, este módulo expone la interfaz para encolar.
// El worker está en: scripts/workers/cloud-message-worker.ts

import { Queue, QueueEvents, type ConnectionOptions } from 'bullmq'
import type { QueuedMessage, QueueConfig } from './types'
import { query } from '@/lib/db'
import { createLogger } from './infrastructure/logger'

const queueLog = createLogger({ correlationId: 'system', operation: 'message_queue' })

const QUEUE_NAME = 'cloud-messages'
const DLQ_NAME   = 'cloud-messages-dlq'

const DEFAULT_CONFIG: QueueConfig = {
  maxRetries:   3,
  backoffBase:  2000,    // 2 segundos
  backoffMax:   60_000,  // 60 segundos máximo
  rateLimitMs:  50,      // 50ms entre mensajes = 20 msg/s
}

function getConnection(): ConnectionOptions {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379'
  const parsed = new URL(url)
  return {
    host:     parsed.hostname,
    port:     parseInt(parsed.port || '6379', 10),
    password: parsed.password || undefined,
    username: parsed.username || undefined,
  }
}

let _queue: Queue | null = null
let _dlq: Queue | null = null

export function getMessageQueue(): Queue {
  if (!_queue) {
    _queue = new Queue(QUEUE_NAME, {
      connection:   getConnection(),
      defaultJobOptions: {
        attempts:       DEFAULT_CONFIG.maxRetries + 1,
        backoff: {
          type:     'exponential',
          delay:    DEFAULT_CONFIG.backoffBase,
        },
        removeOnComplete: { count: 1000 },  // retener últimos 1000 completados
        removeOnFail:     false,             // mantener todos los fallidos para inspección
      },
    })
  }
  return _queue
}

export function getDeadLetterQueue(): Queue {
  if (!_dlq) {
    _dlq = new Queue(DLQ_NAME, {
      connection: getConnection(),
      defaultJobOptions: {
        removeOnComplete: false,
        removeOnFail:     false,
      },
    })
  }
  return _dlq
}

// ─── Encolar un mensaje ───────────────────────────────────────────────────────

export async function enqueueMessage(
  msg:    QueuedMessage,
  config: Partial<QueueConfig> = {},
): Promise<string> {
  const queue = getMessageQueue()
  const cfg = { ...DEFAULT_CONFIG, ...config }

  const job = await queue.add(
    'send-message',
    msg,
    {
      jobId:    msg.jobId,
      attempts: cfg.maxRetries + 1,
      backoff: {
        type:  'exponential',
        delay: cfg.backoffBase,
      },
      // Delay mínimo para respetar rate limit (50ms = 20/s)
      delay: cfg.rateLimitMs,
    },
  )

  // Actualizar estado en DB
  await query(
    `UPDATE cloud_messages SET status = 'queued', queued_at = NOW() WHERE id = $1`,
    [msg.messageId],
  ).catch(err => queueLog.logWarn('failed to update message status', { error: String(err) }))

  return job.id ?? msg.jobId
}

// ─── Mover a Dead Letter Queue ────────────────────────────────────────────────

export async function moveToDeadLetter(
  msg:          QueuedMessage,
  errorMessage: string,
  errorCode?:   number,
): Promise<void> {
  const dlq = getDeadLetterQueue()
  await dlq.add('dead-letter', { ...msg, errorMessage, errorCode, failedAt: new Date().toISOString() })

  await query(
    `UPDATE cloud_messages
     SET status = 'failed', failed_at = NOW(), error_code = $1, error_details = $2
     WHERE id = $3`,
    [errorCode ?? null, errorMessage, msg.messageId],
  ).catch(err => queueLog.logWarn('failed to update DLQ message status', { error: String(err) }))

  queueLog.logError('message moved to DLQ', undefined, {
    messageId:     msg.messageId,
    phoneNumberId: msg.phoneNumberId,
    to:            msg.to,
    errorCode,
    errorMessage,
  })
}

// ─── Estado de la cola ────────────────────────────────────────────────────────

export async function getQueueStats(): Promise<{
  waiting:   number
  active:    number
  completed: number
  failed:    number
  dlq:       number
}> {
  const [queue, dlq] = [getMessageQueue(), getDeadLetterQueue()]
  const [main, dead] = await Promise.all([
    queue.getJobCounts('waiting', 'active', 'completed', 'failed'),
    dlq.getJobCounts('waiting'),
  ])

  return {
    waiting:   main.waiting   ?? 0,
    active:    main.active    ?? 0,
    completed: main.completed ?? 0,
    failed:    main.failed    ?? 0,
    dlq:       dead.waiting   ?? 0,
  }
}

// ─── Limpiar trabajos completados ─────────────────────────────────────────────

export async function cleanCompletedJobs(olderThanHours = 24): Promise<void> {
  const queue = getMessageQueue()
  const graceMs = olderThanHours * 60 * 60 * 1000
  await queue.clean(graceMs, 1000, 'completed')
}
