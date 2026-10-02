'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  Activity, ArrowRight, BarChart2, BookOpen, Bot, CalendarDays, CheckSquare,
  ChevronDown, ClipboardList, FileText, HelpCircle, Info, LayoutDashboard,
  Lightbulb, Megaphone, MessageSquare, Search, Settings, ShieldOff, Star,
  Tag, TrendingUp, UserCog, Users, type LucideIcon,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/layout/PageHeader'
import { useCurrentUser } from '@/lib/useCurrentUser'
import {
  GUIDE_REVIEWED_AT, guideSectionsForUser, matchesGuideSearch,
  type GuideSection,
} from '@/lib/usage-guide'
import { cn } from '@/lib/utils'

const ICONS: Record<string, LucideIcon> = {
  'primeros-pasos': BookOpen, dashboard: LayoutDashboard, contactos: Users,
  segmentacion: Tag, prospectos: Users, prioridades: TrendingUp, campanas: Megaphone,
  estadisticas: BarChart2, efectividad: TrendingUp, conversaciones: MessageSquare,
  plantillas: FileText, lineas: Activity, 'mis-tareas': CheckSquare, calendario: CalendarDays,
  automatizaciones: Bot, blacklist: ShieldOff, tareas: ClipboardList, usuarios: UserCog,
  ajustes: Settings, 'problemas-frecuentes': HelpCircle,
}
const SHORTCUTS = [
  { id: 'contactos', label: 'Preparar una lista', detail: 'Importación, filtros y destinatarios' },
  { id: 'campanas', label: 'Enviar una campaña', detail: 'Mensaje, prueba y seguimiento' },
  { id: 'efectividad', label: 'Medir la efectividad', detail: 'Cargas, usuarios y plataformas en 24 h' },
  { id: 'problemas-frecuentes', label: 'Resolver una duda', detail: 'Permisos, pausas y datos que faltan' },
]
const TIP_STYLES = {
  note: { icon: Info, label: 'Para tener en cuenta', className: 'border-border bg-muted/30' },
  tip: { icon: Lightbulb, label: 'Consejo', className: 'border-primary/20 bg-accent/40' },
  example: { icon: Star, label: 'Ejemplo', className: 'border-success/20 bg-success/5' },
}

function GuideModule({ section, open, onToggle }: { section: GuideSection; open: boolean; onToggle: () => void }) {
  const Icon = ICONS[section.id] ?? BookOpen
  return <section id={section.id} aria-labelledby={`heading-${section.id}`} className="scroll-mt-4 overflow-hidden rounded-xl border bg-card shadow-sm">
    <h2>
      <button id={`heading-${section.id}`} type="button" onClick={onToggle}
        aria-expanded={open} aria-controls={`content-${section.id}`}
        className="flex w-full items-center gap-3 p-4 text-left text-foreground transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:p-5">
        <span className="rounded-lg bg-accent p-2 text-primary"><Icon size={18} aria-hidden="true" /></span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            {section.label}{section.adminOnly && <Badge variant="outline" className="text-[10px]">Administradores</Badge>}
          </span>
          <span className="mt-1 block text-xs font-normal text-muted-foreground">{section.subtitle}</span>
        </span>
        <ChevronDown size={16} aria-hidden="true" className={cn('shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
    </h2>
    <div id={`content-${section.id}`} hidden={!open} className="space-y-5 border-t p-4 sm:p-5">
      <p className="text-sm leading-relaxed">{section.description}</p>
      {section.href && <Link href={section.href} prefetch={false} className="inline-flex items-center gap-1.5 rounded text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Abrir {section.label}<ArrowRight size={14} aria-hidden="true" />
      </Link>}
      <ol className="space-y-4">
        {section.steps.map((step, index) => <li key={step.title} className="flex gap-3">
          <span aria-hidden="true" className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">{index + 1}</span>
          <div className="min-w-0 space-y-1">
            <h3 className="text-sm font-semibold">{step.title}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">{step.detail}</p>
          </div>
        </li>)}
      </ol>
      {!!section.tips?.length && <div className="space-y-2">
        {section.tips.map(tip => {
          const style = TIP_STYLES[tip.kind]
          const TipIcon = style.icon
          return <div key={tip.text} className={cn('flex items-start gap-2.5 rounded-lg border p-3', style.className)}>
            <TipIcon size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-primary" />
            <p className="text-sm leading-relaxed"><span className="font-semibold">{style.label}. </span>{tip.text}</p>
          </div>
        })}
      </div>}
    </div>
  </section>
}

export default function AyudaPage() {
  const { user, permissions, loading, error } = useCurrentUser()
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState(() => new Set(['primeros-pasos']))
  const [activeId, setActiveId] = useState('primeros-pasos')
  const accessible = useMemo(() => guideSectionsForUser(user?.role, permissions), [user?.role, permissions])
  const visible = useMemo(() => accessible.filter(section => matchesGuideSearch(section, search)), [accessible, search])
  const shortcuts = SHORTCUTS.filter(shortcut => accessible.some(section => section.id === shortcut.id))

  const revealSection = useCallback((id: string) => {
    if (!accessible.some(section => section.id === id)) return
    setSearch('')
    setExpanded(previous => new Set(previous).add(id))
    setActiveId(id)
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView?.({ block: 'start' }))
  }, [accessible])

  // Direct links and browser back/forward open their section, including after user permissions load.
  useEffect(() => {
    const revealHash = () => revealSection(window.location.hash.slice(1))
    revealHash()
    window.addEventListener('hashchange', revealHash)
    return () => window.removeEventListener('hashchange', revealHash)
  }, [revealSection])

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined' || loading) return
    const observer = new IntersectionObserver(entries => {
      const current = entries.find(entry => entry.isIntersecting)
      if (current) setActiveId(current.target.id)
    }, { rootMargin: '-10% 0px -65% 0px', threshold: 0 })
    visible.forEach(section => {
      const element = document.getElementById(section.id)
      if (element) observer.observe(element)
    })
    return () => observer.disconnect()
  }, [visible, loading])

  function updateSearch(value: string) {
    setSearch(value)
    if (value.trim()) setExpanded(new Set(accessible.filter(section => matchesGuideSearch(section, value)).map(section => section.id)))
  }

  function toggleSection(id: string) {
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return <div className="mx-auto min-w-0 max-w-6xl space-y-6">
    <PageHeader title="Guía de uso" description="Pasos prácticos para trabajar, medir resultados y resolver dudas."
      actions={<span className="text-xs text-muted-foreground">Revisada el {GUIDE_REVIEWED_AT}</span>} />
    {loading ? <p role="status" className="py-8 text-sm text-muted-foreground">Cargando los temas habilitados para tu cuenta…</p>
      : error ? <p role="alert" className="rounded-lg border p-4 text-sm text-destructive">No se pudieron comprobar tus permisos. Recargá la página para consultar la guía.</p>
      : <>
        <div className="space-y-4 rounded-xl border bg-card p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <BookOpen size={22} aria-hidden="true" className="mt-0.5 shrink-0 text-primary" />
            <div>
              <p className="font-semibold">¿Qué necesitás hacer?</p>
              <p className="mt-1 text-sm text-muted-foreground">Buscá una función o una duda. También podés abrir un recorrido rápido o elegir un tema del índice.</p>
              {user?.role === 'viewer' && <p className="mt-2 text-xs text-muted-foreground">Tu cuenta es de solo lectura. Los pasos de edición y envío requieren permisos adicionales.</p>}
            </div>
          </div>
          <label htmlFor="guide-search" className="sr-only">Buscar en la guía</label>
          <div className="relative">
            <Search size={17} aria-hidden="true" className="absolute left-3 top-3 text-muted-foreground" />
            <Input id="guide-search" type="search" value={search} onChange={event => updateSearch(event.target.value)}
              placeholder="Ej.: importar Excel, carga efectiva, plantilla, campaña pausada…" className="h-10 pl-10" />
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {shortcuts.map(shortcut => <a key={shortcut.id} href={`#${shortcut.id}`} onClick={() => revealSection(shortcut.id)}
              className="rounded-lg border p-3 transition-colors hover:border-primary/40 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span className="flex items-center justify-between gap-2 text-sm font-medium">{shortcut.label}<ArrowRight size={14} aria-hidden="true" /></span>
              <span className="mt-1 block text-xs text-muted-foreground">{shortcut.detail}</span>
            </a>)}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="status" className="text-xs text-muted-foreground">{search.trim() ? (visible.length === 1 ? '1 tema encontrado' : `${visible.length} temas encontrados`) : `${accessible.length} temas disponibles para tu cuenta`}</p>
          <div className="flex flex-wrap gap-2">
            {search && <Button variant="ghost" size="sm" onClick={() => updateSearch('')}>Limpiar búsqueda</Button>}
            <Button variant="outline" size="sm" disabled={!visible.length} onClick={() => setExpanded(new Set(visible.map(section => section.id)))}>Expandir todo</Button>
            <Button variant="outline" size="sm" disabled={!visible.length} onClick={() => setExpanded(new Set())}>Contraer todo</Button>
          </div>
        </div>
        <div className="lg:hidden">
          <label htmlFor="guide-topic" className="mb-1 block text-xs font-medium text-muted-foreground">Ir a un tema</label>
          <select id="guide-topic" className="w-full rounded-lg border bg-card p-2 text-sm"
            value={visible.some(section => section.id === activeId) ? activeId : ''}
            onChange={event => { const id = event.target.value; if (id) { revealSection(id); window.location.hash = id } }}>
            <option value="">Seleccioná un tema</option>
            {visible.map(section => <option key={section.id} value={section.id}>{section.label}</option>)}
          </select>
        </div>

        <div className="flex items-start gap-6">
          <nav aria-label="Índice de la guía" className="sticky top-4 hidden max-h-[75vh] w-56 shrink-0 space-y-1 overflow-y-auto rounded-xl border bg-card p-3 lg:block">
            <p className="px-2 pb-2 text-xs font-semibold text-muted-foreground">Temas de la guía</p>
            {visible.map(section => {
              const Icon = ICONS[section.id] ?? BookOpen
              return <a key={section.id} href={`#${section.id}`} onClick={() => revealSection(section.id)} aria-current={activeId === section.id ? 'location' : undefined}
                className={cn('flex items-center gap-2 rounded-md px-2 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', activeId === section.id ? 'bg-accent font-medium text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
                <Icon size={14} aria-hidden="true" className="shrink-0" />{section.label}
              </a>
            })}
          </nav>
          <div className="min-w-0 flex-1 space-y-3">
            {visible.length ? visible.map(section => <GuideModule key={section.id} section={section} open={expanded.has(section.id)} onToggle={() => toggleSection(section.id)} />)
              : <div className="rounded-xl border bg-card px-4 py-12 text-center">
                <HelpCircle size={30} aria-hidden="true" className="mx-auto mb-3 text-muted-foreground" />
                <p className="text-sm">No encontramos temas para “{search}”.</p>
                <p className="mt-1 text-xs text-muted-foreground">Probá con otra palabra, como “cargas”, “permisos” o “importar”.</p>
                <Button variant="outline" size="sm" className="mt-4" onClick={() => updateSearch('')}>Ver todos los temas</Button>
              </div>}
            <p className="py-5 text-center text-xs leading-relaxed text-muted-foreground">¿Necesitás ayuda con un caso concreto? Compartí el módulo, la hora y el mensaje de error con {user?.role === 'admin' ? 'el equipo de soporte' : 'tu administrador'}.</p>
          </div>
        </div>
      </>}
  </div>
}
