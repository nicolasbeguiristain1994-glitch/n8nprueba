'use client'
import { useState } from 'react'
import { Loader2, ArrowRight, Lock, Mail, MessageSquare, Users, BarChart3 } from 'lucide-react'
import { Brand } from '@/components/layout/Brand'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

export default function LoginPage() {
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 15000)

    try {
      const res = await fetch('/api/auth/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, password }),
        signal:  controller.signal,
      })

      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        setError((data as { error?: string }).error || `Error ${res.status}`)
        return
      }

      // Full page navigation — avoids App Router RSC/session state issues
      window.location.assign('/')
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      setError(aborted
        ? 'El inicio de sesión tardó demasiado. Intentá nuevamente.'
        : 'Error de red al iniciar sesión.')
    } finally {
      window.clearTimeout(timeout)
      setLoading(false)
    }
  }

  return (
    <div className="grid min-h-dvh bg-background lg:grid-cols-[0.9fr_1.1fr]">
      <aside className="hidden flex-col justify-between border-r border-border bg-sidebar p-12 lg:flex xl:p-16">
        <Brand />
        <div className="max-w-md space-y-8">
          <div><p className="mb-4 text-xs font-semibold uppercase tracking-[0.16em] text-primary">Tu espacio de trabajo</p>
            <h2 className="text-4xl font-semibold leading-[1.15] tracking-tight xl:text-5xl">Cada conversación.<br />Una oportunidad.</h2>
            <p className="mt-5 text-base leading-relaxed text-muted-foreground">Clientes, campañas y conversaciones en un solo lugar. Más claridad para tu equipo, más tiempo para lo que importa.</p>
          </div>
          <div className="space-y-4 border-t pt-6">
            {[{ icon: Users, label: 'Todos tus clientes, conectados' }, { icon: MessageSquare, label: 'Conversaciones con contexto' }, { icon: BarChart3, label: 'Tu operación, a simple vista' }].map(({ icon: Icon, label }) => <div key={label} className="flex items-center gap-3 text-sm"><span className="flex size-8 items-center justify-center rounded-lg border bg-card text-primary"><Icon size={16} /></span>{label}</div>)}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">WA Platform · Workspace CRM</p>
      </aside>
      <main className="flex min-h-dvh flex-col items-center justify-center px-6 py-10 sm:px-10">
        <div className="w-full max-w-[360px]">
          <Brand className="mb-10 lg:hidden" />
          <p className="mb-3 text-xs font-medium text-primary">Bienvenido de nuevo</p>
          <h1 className="text-3xl font-semibold tracking-tight">Ingresá a tu espacio</h1>
          <p className="mt-2 mb-8 text-sm text-muted-foreground">Usá tus credenciales para continuar.</p>
          <form onSubmit={handleSubmit} className="space-y-5" aria-busy={loading}>
            <div>
              <label htmlFor="email" className="mb-2 block text-sm font-medium">Email</label>
              <div className="relative"><Mail size={16} aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input id="email" name="email" type="email" autoComplete="email" autoFocus value={email} onChange={e => setEmail(e.target.value)} placeholder="usuario@empresa.com" className="h-11 pl-10" required disabled={loading} />
              </div>
            </div>
            <div>
              <label htmlFor="password" className="mb-2 block text-sm font-medium">Contraseña</label>
              <div className="relative"><Lock size={16} aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input id="password" name="password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Tu contraseña" className="h-11 pl-10" required disabled={loading} />
              </div>
            </div>
            {error && <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={loading || !email || !password} className="h-11 w-full gap-2">
              {loading ? <><Loader2 size={16} className="animate-spin" /> Ingresando…</> : <>Ingresar <ArrowRight size={16} /></>}
            </Button>
          </form>
          <div className="mt-10 flex flex-wrap justify-center gap-x-4 gap-y-2 border-t pt-5 text-[11px] text-muted-foreground">
            <a href="/politica-de-privacidad" target="_blank" rel="noopener noreferrer" className="hover:text-foreground">Política de Privacidad</a>
            <a href="/terminos-y-condiciones" target="_blank" rel="noopener noreferrer" className="hover:text-foreground">Términos y Condiciones</a>
          </div>
        </div>
      </main>
    </div>
  )
}
