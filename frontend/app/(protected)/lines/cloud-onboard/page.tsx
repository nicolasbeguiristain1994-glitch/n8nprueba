'use client'
import { useEffect, useState, type FormEvent } from 'react'
import Link from 'next/link'

type AppConfiguration = { appId: string; name: string; wabaIds: string[]; checks: Record<string, boolean>; webhookPath: string }
type Configuration = AppConfiguration & { apps: AppConfiguration[] }
const labels: Record<string, string> = { appId: 'App ID', appSecret: 'App Secret', verifyToken: 'Token de verificación del webhook', encryptionKey: 'Clave de cifrado', database: 'Base de datos preparada', redis: 'Redis para límites de envío' }
export default function CloudOnboardPage() {
  const [config, setConfig] = useState<Configuration | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ displayPhone: string; message: string } | null>(null)
  const [values, setValues] = useState({ appId: '', wabaId: '', phoneNumberId: '', accessToken: '', pin: '', register: false })
  const [origin, setOrigin] = useState('')
  useEffect(() => {
    setOrigin(window.location.origin)
    fetch('/api/cloud/config').then(async res => { const data = await res.json(); if (!res.ok) throw new Error(data.error || 'No se pudo revisar la configuración'); setConfig(data); setValues(v => ({ ...v, appId: data.appId })) }).catch(e => setError(e.message))
  }, [])
  const selectedApp = config?.apps.find(app => app.appId === values.appId)
  const ready = selectedApp && Object.values(selectedApp.checks).every(Boolean)
  async function connect(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setResult(null)
    try {
      const response = await fetch('/api/cloud/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...values, pin: values.register ? values.pin : undefined }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'No se pudo conectar')
      setResult(data)
    } catch (e) { setError(e instanceof Error ? e.message : 'Error de conexión') }
    finally { setValues(v => ({ ...v, accessToken: '', pin: '' })); setBusy(false) }
  }
  return <main className="mx-auto max-w-2xl space-y-6 p-6">
    <Link href="/lines" className="text-sm text-primary">← Líneas</Link>
    <h1 className="text-2xl font-semibold">Conectar WhatsApp API</h1>
    <p className="text-sm text-muted-foreground">Conectá un número de tu cuenta de WhatsApp Business usando un token de usuario de sistema de Meta. Repetí el proceso por cada Phone Number ID.</p>
    {config && <label className="block text-sm font-medium">Aplicación Meta
      <select className="mt-1 w-full rounded-md border p-2" disabled={busy} value={values.appId} onChange={event => {
        const app = config.apps.find(item => item.appId === event.target.value)
        if (!app) return
        setValues({ appId: app.appId, wabaId: app.wabaIds.length === 1 ? app.wabaIds[0] : '', phoneNumberId: '', accessToken: '', pin: '', register: false })
        setError(''); setResult(null)
      }}>
        {config.apps.map(app => <option key={app.appId} value={app.appId}>{app.name} ({app.appId})</option>)}
      </select>
    </label>}
    <section className="rounded-xl border p-4 space-y-2" aria-label="Preparación del servidor">
      <h2 className="font-semibold">Preparación del servidor</h2>
      {!selectedApp ? <p>Consultando configuración…</p> : Object.entries(selectedApp.checks).map(([key, ok]) => <p key={key} className="text-sm">{ok ? '✓' : 'Pendiente:'} {labels[key] || key}</p>)}
      {selectedApp && <p className="text-sm break-all">URL del webhook: <code>{origin}{selectedApp.webhookPath}</code></p>}
      <p className="text-xs text-muted-foreground">En Meta, verificá esta URL con el token configurado en el servidor y suscribí el campo messages. Para actualizar plantillas, suscribí también message_template_status_update. El token de verificación es distinto del token de acceso.</p>
    </section>
    <form onSubmit={connect} className="space-y-4"><fieldset disabled={busy} className="space-y-4">
      {(['appId','wabaId','phoneNumberId','accessToken'] as const).map(key => <label key={key} className="block text-sm font-medium">{{ appId:'App ID',wabaId:'WABA ID',phoneNumberId:'Phone Number ID',accessToken:'Token de usuario de sistema' }[key]}
        <input className="mt-1 w-full rounded-md border p-2" name={key} type={key === 'accessToken' ? 'password' : 'text'} autoComplete="off" readOnly={key === 'appId'} required value={values[key]} onChange={e => setValues(v => ({ ...v, [key]: e.target.value.trim() }))} />
      </label>)}
      <p className="text-xs text-muted-foreground">El token se cifra en el servidor y no se guarda en este navegador. Necesita whatsapp_business_management y whatsapp_business_messaging sobre la WABA elegida.</p>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={values.register} onChange={e => setValues(v => ({ ...v, register: e.target.checked }))} />Registrar en Cloud API un número ya verificado por SMS o llamada</label>
      {values.register && <label className="block text-sm">PIN de verificación en dos pasos (no es el código SMS)<input className="mt-1 w-full rounded-md border p-2" type="password" autoComplete="off" inputMode="numeric" pattern="[0-9]{6}" required value={values.pin} onChange={e => setValues(v => ({ ...v, pin:e.target.value }))} /></label>}
      <button className="rounded-lg bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50" disabled={busy || !ready}>{busy ? 'Validando conexión…' : 'Validar y conectar número'}</button>
    </fieldset></form>
    {error && <p role="alert" className="rounded-lg border border-red-300 p-3 text-red-700">{error}</p>}
    {result && <div role="status" className="rounded-lg border border-green-300 p-4"><strong>{result.displayPhone}</strong><p>{result.message}</p></div>}
    <Link href="/lines/cloud-inbox" className="block text-primary">Abrir bandeja de WhatsApp API →</Link>
    <p className="text-xs text-muted-foreground">La conexión se valida individualmente. El primer envío, recepción y estado de entrega deben probarse con un destinatario autorizado antes de usar campañas. Los números que siguen usando WhatsApp Business App requieren el flujo de coexistencia de Meta.</p>
  </main>
}
