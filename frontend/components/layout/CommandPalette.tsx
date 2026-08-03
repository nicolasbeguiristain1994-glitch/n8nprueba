'use client'

/**
 * CommandPalette — paleta de comandos global (Cmd+K / Ctrl+K).
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * NOTA DE PERFORMANCE:
 *   - El filtrado y agrupado están memoizados con useMemo.
 *   - CommandItemRow está envuelto en React.memo: solo re-renderiza si cambian
 *     sus props. Esto elimina renders innecesarios al navegar con ↑↓.
 *   - Cuando la lista de comandos supere los 50-60 ítems, reemplazar el scroll
 *     normal por @tanstack/react-virtual para mantener 60fps constante.
 *     Ejemplo de implementación futura disponible en /docs/performance.
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * ACCESIBILIDAD (WCAG 2.2 — patrón combobox + listbox):
 *   - Input: role="combobox", aria-controls, aria-activedescendant, aria-label
 *   - Lista:  role="listbox", id estable para referencia
 *   - Items:  role="option", aria-selected, id estable para aria-activedescendant
 *   - Focus: permanece en el input; la selección visual ES el indicator de foco
 *     (bg-primary/10 + texto primary) — patrón aceptado en WCAG 2.2 §2.4.11
 *
 * ACCIONES vs NAVEGACIÓN:
 *   - type: 'navigate' → router.push(href)
 *   - type: 'action'   → ejecuta action() y emite CustomEvent para que las
 *     páginas puedan reaccionar sin acoplarse al CommandPalette.
 *     Escuchar: window.addEventListener('cmd:new-contact', handler)
 *
 * Sin dependencias adicionales. Usa Dialog de @base-ui/react (ya en el proyecto).
 */

import React, { useEffect, useRef, useState, useCallback, useMemo, memo } from 'react'
import { useRouter } from 'next/navigation'
import {
  Search,
  LayoutDashboard, Users, Megaphone, MessageSquare,
  Activity, Flame, BarChart2, Bot, ShieldOff, FileText,
  UserCog, Settings, UserPlus, SendHorizonal, ArrowRight, Filter, Send, BarChart2 as ReportIcon,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

type CommandGroup = 'Navegación' | 'Admin' | 'Acciones rápidas'

interface CommandItem {
  id: string
  label: string
  /** Descripción opcional que aparece en gris a la derecha del label */
  description?: string
  icon: LucideIcon
  group: CommandGroup
  keywords?: string[]
  /** Navegación: router.push(href) */
  type: 'navigate' | 'action'
  href?: string
  /**
   * Solo para type='action'. Se ejecuta y además emite un CustomEvent con
   * el nombre `cmd:<id>` para que páginas puedan reaccionar de forma desacoplada.
   * Ej: window.addEventListener('cmd:new-contact', handler)
   */
  action?: () => void
}

// ─────────────────────────────────────────────────────────────────────────────
// Catálogo de comandos
// ─────────────────────────────────────────────────────────────────────────────

const COMMAND_ITEMS: CommandItem[] = [
  // Navegación principal
  { id: 'dashboard',     type: 'navigate', label: 'Dashboard',       icon: LayoutDashboard, href: '/',                 group: 'Navegación', keywords: ['inicio', 'home', 'resumen'] },
  { id: 'contacts',      type: 'navigate', label: 'Contactos',        icon: Users,           href: '/contacts',         group: 'Navegación', keywords: ['clientes', 'jugadores', 'lista'] },
  { id: 'campaigns',      type: 'navigate', label: 'Campañas',         icon: Megaphone,     href: '/campaigns',        group: 'Navegación', keywords: ['envios', 'masivo', 'whatsapp'] },
  { id: 'segmentacion',  type: 'navigate', label: 'Segmentación',     icon: Filter,        href: '/segmentacion',     group: 'Navegación', keywords: ['filtros', 'export', 'csv', 'oficina'] },
  { id: 'envio-wa',      type: 'navigate', label: 'Envío WA',         icon: Send,          href: '/envio-whatsapp',   group: 'Navegación', keywords: ['mensaje', 'masivo', 'whatsapp', 'csv'] },
  { id: 'reportes',      type: 'navigate', label: 'Reportes',         icon: ReportIcon,    href: '/reportes',         group: 'Navegación', keywords: ['reporte', 'efectividad', 'enviados', 'dashboard'] },
  { id: 'conversations', type: 'navigate', label: 'Conversaciones',   icon: MessageSquare,   href: '/conversations',    group: 'Navegación', keywords: ['mensajes', 'chats', 'inbox'] },
  { id: 'lines',         type: 'navigate', label: 'Líneas',           icon: Activity,        href: '/lines',            group: 'Navegación', keywords: ['numeros', 'telefonos'] },
  { id: 'warmup',        type: 'navigate', label: 'Calentamiento',    icon: Flame,           href: '/warmup',           group: 'Navegación', keywords: ['warming', 'activacion'] },

  // Admin
  { id: 'estadisticas',  type: 'navigate', label: 'Estadísticas',     icon: BarChart2,       href: '/estadisticas',     group: 'Admin', keywords: ['reportes', 'kpi', 'metricas', 'analytics'] },
  { id: 'automations',   type: 'navigate', label: 'Automatizaciones', icon: Bot,             href: '/automatizaciones', group: 'Admin', keywords: ['bots', 'flujos', 'workflows'] },
  { id: 'blacklist',     type: 'navigate', label: 'Blacklist',        icon: ShieldOff,       href: '/blacklist',        group: 'Admin', keywords: ['bloqueados', 'ban'] },
  { id: 'templates',     type: 'navigate', label: 'Plantillas',       icon: FileText,        href: '/templates',        group: 'Admin', keywords: ['mensajes', 'textos'] },
  { id: 'users',         type: 'navigate', label: 'Usuarios',         icon: UserCog,         href: '/users',            group: 'Admin', keywords: ['operadores', 'equipo'] },
  { id: 'settings',      type: 'navigate', label: 'Ajustes',          icon: Settings,        href: '/settings',         group: 'Admin', keywords: ['configuracion', 'perfil'] },

  // Acciones rápidas — emiten CustomEvent al ejecutarse
  {
    id: 'new-contact',
    type: 'action',
    label: 'Nuevo Contacto',
    description: 'Abrir formulario de creación',
    icon: UserPlus,
    group: 'Acciones rápidas',
    keywords: ['crear', 'agregar', 'añadir', 'contacto', 'nuevo'],
    action: () => {
      // Primero navegar a /contacts si no estamos ahí
      if (!window.location.pathname.startsWith('/contacts')) {
        window.location.href = '/contacts'
        // El evento se emitirá al cargar la página — no es ideal sin state externo,
        // así que en este caso simplemente navegamos.
        return
      }
      // Si ya estamos en /contacts, emitir el evento para abrir el modal
      window.dispatchEvent(new CustomEvent('cmd:new-contact'))
    },
  },
  {
    id: 'new-campaign',
    type: 'action',
    label: 'Nueva Campaña',
    description: 'Abrir asistente de campaña',
    icon: SendHorizonal,
    group: 'Acciones rápidas',
    keywords: ['crear', 'agregar', 'campaña', 'envio', 'nuevo', 'masivo'],
    action: () => {
      if (!window.location.pathname.startsWith('/campaigns')) {
        window.location.href = '/campaigns'
        return
      }
      window.dispatchEvent(new CustomEvent('cmd:new-campaign'))
    },
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (fuera del componente — estables, no se recrean)
// ─────────────────────────────────────────────────────────────────────────────

function normalizeStr(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

function matchesQuery(item: CommandItem, normalizedQuery: string): boolean {
  if (normalizeStr(item.label).includes(normalizedQuery)) return true
  if (item.description && normalizeStr(item.description).includes(normalizedQuery)) return true
  return (item.keywords ?? []).some(k => normalizeStr(k).includes(normalizedQuery))
}

const GROUP_ORDER: CommandGroup[] = ['Acciones rápidas', 'Navegación', 'Admin']

// ─────────────────────────────────────────────────────────────────────────────
// CommandItemRow — memoizado para evitar re-renders al mover selección
// ─────────────────────────────────────────────────────────────────────────────

interface CommandItemRowProps {
  item: CommandItem
  isSelected: boolean
  globalIndex: number
  onExecute: (item: CommandItem) => void
  onHover: (index: number) => void
}

/**
 * React.memo: solo re-renderiza si cambian sus props.
 * Gracias a onExecute/onHover memoizados con useCallback en el padre,
 * el único prop que cambia al navegar con ↑↓ es `isSelected` — y solo
 * para los 2 ítems que cambian de estado, no toda la lista.
 */
const CommandItemRow = memo(function CommandItemRow({
  item,
  isSelected,
  globalIndex,
  onExecute,
  onHover,
}: CommandItemRowProps) {
  const Icon = item.icon
  const itemId = `cmd-item-${item.id}`

  return (
    <button
      id={itemId}
      data-index={globalIndex}
      role="option"
      aria-selected={isSelected}
      onClick={() => onExecute(item)}
      onMouseEnter={() => onHover(globalIndex)}
      className={cn(
        'w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors text-left',
        // El fondo del ítem seleccionado actúa como focus indicator (WCAG 2.2 §2.4.11)
        isSelected
          ? 'bg-primary/10 text-foreground'
          : 'text-foreground/80 hover:bg-muted',
      )}
    >
      {/* Ícono con color del primary cuando está seleccionado */}
      <Icon
        size={15}
        className={cn(
          'shrink-0 transition-colors',
          isSelected ? 'text-primary' : 'text-muted-foreground',
        )}
        aria-hidden="true"
      />

      {/* Label + description */}
      <span className="flex-1 min-w-0">
        <span className={cn('block truncate', isSelected && 'font-medium')}>
          {item.label}
        </span>
        {item.description && (
          <span className="block text-[11px] text-muted-foreground truncate mt-0.5">
            {item.description}
          </span>
        )}
      </span>

      {/* Badge de tipo para acciones */}
      {item.type === 'action' && (
        <span className="shrink-0 text-[10px] text-primary/70 bg-primary/10 rounded px-1.5 py-0.5 font-medium">
          Acción
        </span>
      )}

      {/* Hint Enter solo en el ítem seleccionado */}
      {isSelected && item.type === 'navigate' && (
        <ArrowRight size={13} className="shrink-0 text-primary" aria-hidden="true" />
      )}
      {isSelected && item.type === 'action' && (
        <kbd
          className="shrink-0 text-[10px] bg-primary/10 border border-primary/20 rounded px-1.5 py-0.5 font-mono text-primary"
          aria-hidden="true"
        >
          ↵
        </kbd>
      )}
    </button>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// CommandPalette
// ─────────────────────────────────────────────────────────────────────────────

const LISTBOX_ID = 'cmd-palette-listbox'

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const router = useRouter()

  // ── Shortcut global Cmd+K / Ctrl+K ──────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        onOpenChange(true)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onOpenChange])

  // ── Reset + focus al abrir ───────────────────────────────────────────────
  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIndex(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // ── Filtrado memoizado ───────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const trimmed = query.trim()
    if (!trimmed) return COMMAND_ITEMS
    const nq = normalizeStr(trimmed)
    return COMMAND_ITEMS.filter(item => matchesQuery(item, nq))
  }, [query])

  // ── Agrupado memoizado (depende de filtered) ─────────────────────────────
  const groups = useMemo(() => {
    const map = new Map<CommandGroup, CommandItem[]>()
    for (const item of filtered) {
      const list = map.get(item.group) ?? []
      list.push(item)
      map.set(item.group, list)
    }
    // Reordenar según GROUP_ORDER
    return GROUP_ORDER
      .filter(g => map.has(g))
      .map(g => ({ group: g, items: map.get(g)! }))
  }, [filtered])

  // ── Reset selección cuando cambia la query ───────────────────────────────
  useEffect(() => { setSelectedIndex(0) }, [query])

  // ── Ejecutar un ítem (navigate o action) ────────────────────────────────
  const executeItem = useCallback(
    (item: CommandItem) => {
      onOpenChange(false)

      if (item.type === 'navigate' && item.href) {
        router.push(item.href)
        return
      }

      if (item.type === 'action' && item.action) {
        // Ejecutar después de cerrar el dialog para evitar conflictos de foco
        setTimeout(() => {
          item.action!()
          // Emitir CustomEvent genérico para que las páginas puedan escuchar
          window.dispatchEvent(new CustomEvent(`cmd:${item.id}`))
        }, 80)
      }
    },
    [onOpenChange, router],
  )

  // Callbacks estables para CommandItemRow (evitan que React.memo invalide)
  const handleHover = useCallback((index: number) => setSelectedIndex(index), [])

  // ── Navegación por teclado ───────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex(i => Math.min(i + 1, filtered.length - 1))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex(i => Math.max(i - 1, 0))
          break
        case 'Enter':
          e.preventDefault()
          if (filtered[selectedIndex]) executeItem(filtered[selectedIndex])
          break
      }
    },
    [filtered, selectedIndex, executeItem],
  )

  // ── Scroll automático al ítem seleccionado ───────────────────────────────
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const el = list.querySelector(`[data-index="${selectedIndex}"]`) as HTMLElement
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Calcular el id del ítem activo para aria-activedescendant
  const activeDescendantId = filtered[selectedIndex]
    ? `cmd-item-${filtered[selectedIndex].id}`
    : undefined

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="p-0 gap-0 overflow-hidden max-w-lg sm:max-w-lg"
        aria-label="Paleta de comandos"
      >
        {/* ── Input de búsqueda ── */}
        {/*
         * div[role="combobox"]: envuelve el input según el patrón ARIA.
         * El input en sí tiene role="searchbox" y los aria-* de control.
         */}
        <div
          role="combobox"
          aria-expanded={filtered.length > 0}
          aria-haspopup="listbox"
          aria-owns={LISTBOX_ID}
          className="flex items-center gap-3 px-4 border-b border-border"
        >
          <Search size={15} className="text-muted-foreground shrink-0" aria-hidden="true" />
          <input
            ref={inputRef}
            role="searchbox"
            aria-label="Buscar comandos y páginas"
            aria-autocomplete="list"
            aria-controls={LISTBOX_ID}
            aria-activedescendant={activeDescendantId}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Buscar comandos y páginas…"
            className={cn(
              'flex-1 h-12 bg-transparent text-sm outline-none',
              'placeholder:text-muted-foreground',
              // Ring visible solo cuando el input recibe foco con teclado
              'focus-visible:ring-0', // el ring va en el DialogContent, no aquí
            )}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd
            className="shrink-0 text-[10px] bg-muted border border-border rounded px-1.5 py-0.5 font-mono text-muted-foreground/70"
            aria-hidden="true"
          >
            ESC
          </kbd>
        </div>

        {/* ── Lista de resultados ── */}
        <div
          id={LISTBOX_ID}
          ref={listRef}
          role="listbox"
          aria-label="Comandos disponibles"
          aria-multiselectable="false"
          className="overflow-y-auto max-h-[340px] py-2"
        >
          {filtered.length === 0 ? (
            <p
              role="status"
              className="text-sm text-muted-foreground text-center py-8"
            >
              Sin resultados para &ldquo;{query}&rdquo;
            </p>
          ) : (
            groups.map(({ group, items }) => (
              <div key={group} role="group" aria-label={group}>
                {/* Encabezado de grupo */}
                <p className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 select-none">
                  {group}
                </p>

                {items.map(item => {
                  const globalIndex = filtered.indexOf(item)
                  return (
                    <CommandItemRow
                      key={item.id}
                      item={item}
                      isSelected={globalIndex === selectedIndex}
                      globalIndex={globalIndex}
                      onExecute={executeItem}
                      onHover={handleHover}
                    />
                  )
                })}
              </div>
            ))
          )}
        </div>

        {/* ── Footer de ayuda de teclado ── */}
        <div
          className="flex items-center gap-4 px-4 py-2.5 border-t border-border bg-muted/30"
          aria-hidden="true"
        >
          <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground/60">
            <kbd className="bg-background border border-border rounded px-1 py-0.5 font-mono">↑</kbd>
            <kbd className="bg-background border border-border rounded px-1 py-0.5 font-mono">↓</kbd>
            navegar
          </span>
          <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground/60">
            <kbd className="bg-background border border-border rounded px-1.5 py-0.5 font-mono">↵</kbd>
            ejecutar
          </span>
          <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground/60">
            <kbd className="bg-background border border-border rounded px-1.5 py-0.5 font-mono">ESC</kbd>
            cerrar
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
