'use client'

import { useState } from 'react'
import { Popover } from '@base-ui/react/popover'
import { ChevronDown, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'

const LINES = Array.from({ length: 100 }, (_, index) => String(index + 1))

export function ContactLineFilter({ value, onChange }: {
  value: string[]
  onChange: (lines: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const query = search.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
  const visibleLines = LINES.filter(line => `linea ${line}`.includes(query))
  const label = value.length === 0 ? 'Todas las líneas' : value.length === 1 ? `Línea ${value[0]}` : `${value.length} líneas`

  const toggle = (line: string, checked: boolean) => {
    const next = checked ? [...value, line] : value.filter(item => item !== line)
    onChange([...new Set(next)].sort((a, b) => Number(a) - Number(b)))
  }

  return <Popover.Root open={open} onOpenChange={next => { setOpen(next); if (!next) setSearch('') }}>
    <Popover.Trigger render={<Button type="button" variant="outline" className={value.length ? 'border-primary/40 bg-primary/5 text-primary' : ''} />}
      aria-label={`Filtrar por líneas: ${label}`}>
      {label}<ChevronDown size={14} aria-hidden="true" />
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner sideOffset={6} align="start" collisionPadding={16} className="z-50">
        <Popover.Popup className="flex max-h-[min(28rem,var(--available-height))] w-72 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg outline-none">
          <div className="space-y-3 border-b p-3">
            <Popover.Title className="text-sm font-semibold">Filtrar por líneas</Popover.Title>
            <Popover.Description className="text-xs leading-relaxed text-muted-foreground">Podés elegir varias. Se incluyen contactos de cualquiera de las líneas seleccionadas.</Popover.Description>
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input aria-label="Buscar línea" placeholder="Buscar línea…" value={search} onChange={event => setSearch(event.target.value)} className="h-9 pl-9" />
            </div>
          </div>
          <div className="min-h-0 overflow-y-auto p-2" role="group" aria-label="Líneas disponibles">
            {visibleLines.map(line => <label key={line} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-sm hover:bg-muted">
              <Checkbox checked={value.includes(line)} onCheckedChange={checked => toggle(line, checked)} />
              Línea {line}
            </label>)}
            {!visibleLines.length && <p className="p-3 text-sm text-muted-foreground">No hay líneas con esa búsqueda.</p>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/20 p-3">
            <Button type="button" size="sm" variant="ghost" disabled={!value.length} onClick={() => onChange([])}>Todas las líneas</Button>
            <Popover.Close render={<Button type="button" size="sm" />}>Listo</Popover.Close>
          </div>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>
}
