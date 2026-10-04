'use client'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Info, Loader2, ShieldCheck, XCircle } from 'lucide-react'
import type { CheckStatus, CloudLineReadiness, CloudReadinessResponse, ReadinessCheck } from '@/lib/cloud-api/campaign-readiness'

const AR_TZ = 'America/Argentina/Buenos_Aires'

function formatAR(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return `${d.toLocaleString('es-AR', { timeZone: AR_TZ, hourCycle: 'h23' })} (hora Argentina)`
}

const CHECK_ICON: Record<CheckStatus, { icon: typeof Info; className: string; label: string }> = {
  ok:       { icon: CheckCircle2,  className: 'text-success',  label: 'Correcto' },
  warning:  { icon: AlertTriangle, className: 'text-amber-600',  label: 'Advertencia' },
  blocking: { icon: XCircle,       className: 'text-destructive',    label: 'Bloqueo' },
  info:     { icon: Info,          className: 'text-muted-foreground',   label: 'Informativo' },
}

const SUMMARY: Record<CloudLineReadiness['summary'], { text: string; className: string }> = {
  blocked:               { text: 'Con bloqueos',                        className: 'bg-destructive/15 text-destructive' },
  warnings:              { text: 'Con advertencias',                    className: 'bg-warning/15 text-warning' },
  local_checks_complete: { text: 'Comprobaciones locales completas',    className: 'bg-muted text-foreground' },
}

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; data: CloudReadinessResponse }

function errorMessage(status: number): string {
  if (status === 401) return 'La sesión venció. Volvé a iniciar sesión para revisar WhatsApp API.'
  if (status === 403) return 'No tenés permiso para ver el diagnóstico de WhatsApp API.'
  return 'No se pudo obtener el diagnóstico local de WhatsApp API. Reintentá en unos minutos.'
}

function isResponse(v: unknown): v is CloudReadinessResponse {
  return !!v && typeof v === 'object' && Array.isArray((v as CloudReadinessResponse).lines)
    && typeof (v as CloudReadinessResponse).checked_at === 'string'
}

export function CloudReadiness() {
  const id = useId()
  const titleId = `${id}-title`
  const bodyId = `${id}-body`
  const [state, setState] = useState<State>({ kind: 'idle' })
  const [expanded, setExpanded] = useState(true)
  const controllerRef = useRef<AbortController | null>(null)
  const requestRef = useRef(0)

  useEffect(() => () => controllerRef.current?.abort(), [])

  const load = useCallback(async () => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    const requestId = ++requestRef.current
    setExpanded(true)
    setState({ kind: 'loading' })
    let next: State
    try {
      const res = await fetch('/api/campaigns/cloud-readiness', { cache: 'no-store', signal: controller.signal })
      const body: unknown = res.ok ? await res.json() : null
      if (!res.ok) next = { kind: 'error', message: errorMessage(res.status) }
      else if (!isResponse(body)) next = { kind: 'error', message: errorMessage(500) }
      else next = { kind: 'loaded', data: body }
    } catch {
      next = { kind: 'error', message: errorMessage(500) }
    }
    // Ignora respuestas de consultas reemplazadas o de un componente desmontado.
    if (controller.signal.aborted || requestId !== requestRef.current) return
    setState(next)
  }, [])

  const loading = state.kind === 'loading'
  const data = state.kind === 'loaded' ? state.data : null

  return (
    <section aria-labelledby={titleId} className="border border-border rounded-lg bg-card">
      <div className="flex items-center justify-between flex-wrap gap-3 px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <ShieldCheck size={16} className="text-muted-foreground shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-medium">Estado de WhatsApp API</h2>
            {data && (
              <p className="text-xs text-muted-foreground">Revisado: {formatAR(data.checked_at)}</p>
            )}
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          {state.kind !== 'idle' && (
            <Button
              variant="ghost" size="sm" type="button"
              aria-expanded={expanded} aria-controls={bodyId}
              onClick={() => setExpanded(e => !e)}
            >
              {expanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
              <span className="ml-1">{expanded ? 'Ocultar' : 'Mostrar'}</span>
            </Button>
          )}
          <Button variant="outline" size="sm" type="button" onClick={load} disabled={loading} aria-busy={loading}>
            {loading && <Loader2 size={13} className="mr-1 animate-spin" aria-hidden="true" />}
            Revisar WhatsApp API
          </Button>
        </div>
      </div>

      {state.kind !== 'idle' && expanded && (
        <div id={bodyId} className="border-t border-border px-4 py-3 space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            Diagnóstico basado en datos almacenados en la plataforma: no consulta Meta en vivo ni autoriza envíos,
            y un resultado sin bloqueos no certifica que la línea pueda enviar.
            Las cuotas por hora y día de la línea, la ventana de 24 h, el opt-in, los límites de mensajería,
            la facturación y el estado del proveedor se validan aparte.
            El catálogo de plantillas se actualiza desde Nueva campaña.
          </p>

          {loading && <p role="status" className="text-muted-foreground">Revisando datos locales…</p>}

          {state.kind === 'error' && (
            <div role="alert" className="bg-destructive/10 border border-destructive/20 rounded px-3 py-2 text-destructive">
              {state.message}
            </div>
          )}

          {data && data.lines.length === 0 && (
            <p className="text-muted-foreground">
              No hay líneas WhatsApp Cloud API visibles para tu usuario. Podés configurarlas en{' '}
              <Link href="/lines/cloud-onboard" className="underline">Conectar número Cloud</Link>.
            </p>
          )}

          {data && data.lines.length > 0 && (
            <ul className="space-y-3">
              {data.lines.map(line => <LineReadiness key={line.cloud_number_id ?? `line-${line.line_id}`} line={line} />)}
            </ul>
          )}

          {data && (
            <p className="text-xs text-muted-foreground">
              Configuración de líneas: <Link href="/lines" className="underline">Líneas</Link>
              {' · '}<Link href="/lines/cloud-onboard" className="underline">Conectar número Cloud</Link>
              {' · '}Recepción de mensajes: <Link href="/lines/cloud-inbox" className="underline">Bandeja Cloud</Link>
            </p>
          )}
        </div>
      )}
    </section>
  )
}

// Dato concreto que acompaña a ciertos checks (fecha en hora Argentina o conteo).
function checkValue(check: ReadinessCheck, line: CloudLineReadiness): string | null {
  switch (check.key) {
    case 'token_expiry':       return line.number_linked ? formatAR(line.token_expires_at) ?? 'Fecha desconocida' : null
    case 'last_webhook':       return formatAR(line.last_webhook_at) ?? 'Sin registro'
    case 'approved_templates': return String(line.approved_template_count)
    default:                   return null
  }
}

function LineReadiness({ line }: { line: CloudLineReadiness }) {
  const name = line.line_name || line.verified_name || 'Línea sin nombre'
  const summary = SUMMARY[line.summary]
  return (
    <li className="border border-border rounded-md p-3 space-y-2" aria-label={`Diagnóstico de ${name}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{name}</p>
          {line.verified_name && line.verified_name !== name && (
            <p className="text-xs text-muted-foreground">Nombre verificado: {line.verified_name}</p>
          )}
        </div>
        <span className={`text-xs px-2 py-0.5 rounded-full ${summary.className}`}>{summary.text}</span>
      </div>

      <ul className="space-y-1">
        {line.checks.map(check => {
          const meta = CHECK_ICON[check.status]
          const Icon = meta.icon
          const value = checkValue(check, line)
          return (
            <li key={check.key} className="flex items-start gap-2" data-status={check.status} data-check={check.key}>
              <Icon size={14} className={`mt-0.5 shrink-0 ${meta.className}`} aria-hidden="true" />
              <span>
                <span className="sr-only">{meta.label}: </span>
                <span className="font-medium">{check.label}{value !== null && <>: <span data-value>{value}</span></>}.</span>{' '}
                <span className="text-muted-foreground">{check.detail}</span>
              </span>
            </li>
          )
        })}
      </ul>
    </li>
  )
}
