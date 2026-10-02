'use client'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EMPTY_INACTIVITY, inactivityError, inactivityLabel, type InactivityRange } from '@/lib/inactivity-range'

export function InactivityRangeFilter({ value, onChange, period = false }: { period?: boolean; value: InactivityRange; onChange: (range: InactivityRange) => void }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  const id = useId()
  const error = inactivityError(draft)
  const active = value.min !== '' || value.max !== ''
  return <div className="relative">
    <Button type="button" variant={active ? 'secondary' : 'outline'} className="h-9 font-normal"
      aria-expanded={open} aria-controls={`${id}-range`}
      onClick={() => { setDraft(value); setOpen(!open) }}>
      {inactivityLabel(period ? { ...value, mode: 'period' } : value)}
    </Button>
    {open && <div id={`${id}-range`} className="absolute left-0 top-full z-50 mt-1 w-80 max-w-[calc(100vw-2rem)] space-y-3 rounded-md border bg-popover p-4 shadow-md"
      onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}>
      <p className="text-sm font-medium">{period ? 'Movimientos ocurridos hace…' : 'Días desde el último movimiento'}</p>
      <div className="grid grid-cols-2 gap-3">
        <label htmlFor={`${id}-min`} className="space-y-1 text-sm">Más de
          <Input id={`${id}-min`} type="number" min={0} max={36500} step={1} placeholder="Sin mínimo" value={draft.min}
            onChange={e => setDraft({ ...draft, min: e.target.value })} />
        </label>
        <label htmlFor={`${id}-max`} className="space-y-1 text-sm">Hasta (inclusive)
          <Input id={`${id}-max`} type="number" min={0} max={36500} step={1} placeholder="Sin máximo" value={draft.max}
            onChange={e => setDraft({ ...draft, max: e.target.value })} />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{period
        ? 'Incluye a quienes tuvieron al menos una carga o retiro en ese período, aunque también hayan tenido movimientos más recientes. Días calendario de Argentina; se respeta la plataforma elegida.'
        : 'Se cuenta desde la última carga o retiro, en días calendario de Argentina. Quienes superan el máximo o no tienen movimientos identificables quedan fuera. Se respeta la plataforma elegida.'}</p>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => { onChange(EMPTY_INACTIVITY); setOpen(false) }}>Limpiar rango</Button>
        <Button type="button" size="sm" disabled={!!error} onClick={() => { onChange(draft); setOpen(false) }}>Aplicar rango</Button>
      </div>
    </div>}
  </div>
}

// Choose either meaning explicitly; the inactive control shows empty bounds.
export function MovementRangeFilters({ value, onChange }: { value: InactivityRange; onChange: (range: InactivityRange) => void }) {
  return <>
    <InactivityRangeFilter value={value.mode === 'period' ? EMPTY_INACTIVITY : value} onChange={onChange} />
    <InactivityRangeFilter period value={value.mode === 'period' ? value : EMPTY_INACTIVITY}
      onChange={range => onChange(range.min === '' && range.max === '' ? EMPTY_INACTIVITY : { ...range, mode: 'period' })} />
  </>
}
