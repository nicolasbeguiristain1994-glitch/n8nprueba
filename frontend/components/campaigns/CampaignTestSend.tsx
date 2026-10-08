'use client'

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FlaskConical, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import type { CampaignTestAttempt, CampaignTestSnapshot } from '@/lib/campaign-test-types'

const STATUS = { sending: 'En procesamiento', sent: 'Aceptado por Meta', failed: 'Falló', uncertain: 'Sin confirmar' }
type PendingRequest = { request_id: string; recipient_id: string; line_id: string }

export function CampaignTestSend({ campaignId }: { campaignId: string }) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<CampaignTestSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<CampaignTestAttempt | null>(null)
  const [recipientId, setRecipientId] = useState('')
  const [lineId, setLineId] = useState('')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [retryPending, setRetryPending] = useState(false)
  const pendingRequest = useRef<PendingRequest | null>(null)
  const busyRef = useRef(false)
  const path = `/api/campaigns/${campaignId}/test-send`

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch(path)
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'No se pudieron cargar las pruebas.')
      const snapshot = body as CampaignTestSnapshot
      setData(snapshot)
      setRecipientId(prev => snapshot.recipients.some(r => r.id === prev) ? prev : snapshot.recipients[0]?.id || '')
      setLineId(prev => snapshot.lines.some(l => l.id === prev) ? prev : snapshot.lines[0]?.id || '')
    } catch (err) { setError(err instanceof Error ? err.message : 'No se pudieron cargar las pruebas.') }
    finally { setLoading(false) }
  }

  const register = async () => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true); setError(null)
    try {
      const res = await fetch('/api/campaign-test-recipients', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ first_name: name.trim(), phone_number: phone.trim() }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'No se pudo registrar el número.')
      setName(''); setPhone(''); setRecipientId(body.recipient.id)
      await load()
    } catch (err) { setError(err instanceof Error ? err.message : 'No se pudo registrar el número.') }
    finally { busyRef.current = false; setBusy(false) }
  }

  const remove = async () => {
    if (busyRef.current || !recipientId) return
    busyRef.current = true; setBusy(true); setError(null)
    try {
      const res = await fetch('/api/campaign-test-recipients', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: recipientId }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'No se pudo quitar el número.')
      await load()
    } catch (err) { setError(err instanceof Error ? err.message : 'No se pudo quitar el número.') }
    finally { busyRef.current = false; setBusy(false) }
  }

  const send = async () => {
    if (busyRef.current || (!pendingRequest.current && (!recipientId || !lineId))) return
    busyRef.current = true; setBusy(true); setError(null); setResult(null)
    // Reuse the same request after a network failure. A retry must never create a second send.
    const payload = pendingRequest.current ?? { request_id: crypto.randomUUID(), recipient_id: recipientId, line_id: lineId }
    pendingRequest.current = payload
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const body = await res.json()
      if (!res.ok) {
        if (res.status < 500) { pendingRequest.current = null; setRetryPending(false) }
        throw new Error(body.error || 'No se pudo procesar la prueba.')
      }
      setResult(body.attempt)
      if (body.attempt.status === 'sending') {
        setRetryPending(true)
      } else {
        pendingRequest.current = null; setRetryPending(false)
      }
      await load()
    } catch (err) {
      setRetryPending(pendingRequest.current !== null)
      setError(err instanceof Error ? err.message : 'No se pudo confirmar la respuesta. Reintentá la misma solicitud para consultar su resultado.')
    } finally { busyRef.current = false; setBusy(false) }
  }

  return <section className="rounded-lg border border-border p-3 space-y-3">
    <Button type="button" variant="outline" onClick={() => {
      setOpen(prev => !prev)
      if (!open) { setError(null); void load() }
    }} aria-expanded={open}>
      <FlaskConical size={15} className="mr-2" /> {open ? 'Cerrar pruebas' : 'Enviar prueba'}
    </Button>
    {open && <>
      <p className="text-sm text-muted-foreground">Enviá la plantilla a uno de tus números registrados, sin el límite de frecuencia del contacto. Cada prueba conserva su historial y respeta los límites de la línea y de Meta.</p>
      {loading && <p className="text-xs text-muted-foreground">Actualizando pruebas…</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {data && <>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-xs block mb-1" htmlFor="test-recipient">Número de prueba</label>
            <select id="test-recipient" className="w-full rounded-md border bg-background p-2 text-sm" value={recipientId}
                    disabled={busy || retryPending} onChange={e => setRecipientId(e.target.value)}>
              <option value="">Seleccioná un número</option>
              {data.recipients.map(r => <option key={r.id} value={r.id}>{r.first_name} · {r.phone_number}</option>)}
            </select>
            {recipientId && <Button type="button" variant="ghost" size="sm" onClick={remove} disabled={busy || retryPending}>
              <Trash2 size={12} className="mr-1" /> Quitar número de pruebas
            </Button>}
          </div>
          <div>
            <label className="text-xs block mb-1" htmlFor="test-line">Línea de envío</label>
            <select id="test-line" className="w-full rounded-md border bg-background p-2 text-sm" value={lineId}
                    disabled={busy || retryPending} onChange={e => setLineId(e.target.value)}>
              <option value="">Seleccioná una línea</option>
              {data.lines.map(l => <option key={l.id} value={l.id}>{l.display_name}</option>)}
            </select>
            {data.lines.length === 0 && <p className="text-xs text-orange-600 mt-1">No hay líneas disponibles para esta plantilla. La línea debe pertenecer a la misma cuenta de WhatsApp de la plantilla, estar habilitada y tener cupo disponible.</p>}
          </div>
        </div>
        <details open={data.recipients.length === 0} className="rounded border p-3">
          <summary className="text-sm cursor-pointer">Registrar mi número de prueba</summary>
          <p className="text-xs text-muted-foreground mt-2">Registrá únicamente números propios o del equipo. El nombre se usa para personalizar la plantilla.</p>
          <div className="grid gap-2 sm:grid-cols-2 mt-2">
            <div><label htmlFor="test-name" className="text-xs">Nombre</label><Input id="test-name" maxLength={100} value={name} onChange={e => setName(e.target.value)} disabled={busy || retryPending} /></div>
            <div><label htmlFor="test-phone" className="text-xs">Teléfono con código de país</label><Input id="test-phone" type="tel" placeholder="+5491112345678" value={phone} onChange={e => setPhone(e.target.value)} disabled={busy || retryPending} /></div>
          </div>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={register} disabled={busy || retryPending || !name.trim() || !/^\+[1-9]\d{6,14}$/.test(phone.trim())}>Registrar número</Button>
        </details>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={send} disabled={busy || loading || (!retryPending && (!recipientId || !lineId))}>
            {busy ? <Loader2 size={14} className="mr-2 animate-spin" /> : <FlaskConical size={14} className="mr-2" />}
            {retryPending ? 'Reintentar prueba pendiente' : result ? 'Enviar otra prueba' : 'Enviar prueba a este número'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => { setError(null); void load() }} disabled={loading || busy}>
            <RefreshCw size={13} className="mr-1" /> Actualizar pruebas
          </Button>
        </div>
      </>}
      {result && <p role="status" className={`text-sm ${result.status === 'sent' ? 'text-success' : 'text-muted-foreground'}`}>
        {STATUS[result.status]} · {result.first_name} ({result.phone_number}). {result.error}
        {result.status === 'sent' && ' La entrega se confirma en el WhatsApp destinatario.'}
      </p>}
      {!!data?.attempts.length && <div className="space-y-2">
        <p className="text-xs font-medium">Últimas pruebas de esta campaña</p>
        {data.attempts.map(a => <div key={a.id} className="text-xs border-t pt-2">
          <p>{a.first_name} · {a.phone_number} · {a.line_name} · {STATUS[a.status]}</p>
          <p className="text-muted-foreground">{new Date(a.created_at).toLocaleString('es-AR')}</p>
          {a.error && <p className="text-destructive">{a.error}</p>}
        </div>)}
      </div>}
    </>}
  </section>
}
