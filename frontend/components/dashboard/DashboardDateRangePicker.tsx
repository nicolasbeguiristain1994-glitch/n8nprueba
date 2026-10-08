'use client'

import { useEffect, useState } from 'react'
import { CalendarRange } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { describeDateRange, exclusiveEndDate, validCustomRange } from '@/lib/dashboard-date-range'
import { DATE_RANGE_LABELS, computeDateRange, type DateRange, type DateRangePreset } from './types'

/**
 * Draft dates never change the active query until the user applies a valid range.
 * Custom ranges run from Desde 00:00 up to, but not including, Hasta 00:00 (Argentina).
 */
export function DashboardDateRangePicker({ value, onChange }: { value: DateRange; onChange: (r: DateRange) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value.preset, value.from, value.to])
  const valid = validCustomRange(draft.from, draft.to)
  const pending = draft.preset !== value.preset || draft.from !== value.from || draft.to !== value.to
  function preset(p: DateRangePreset) {
    // Switching to custom keeps the same days: the included last day becomes the exclusive next midnight.
    if (p === 'custom') { setDraft(value.preset === 'custom' ? value : { preset: p, from: value.from, to: exclusiveEndDate(value) }); return }
    const next = { preset: p, ...computeDateRange(p) }; setDraft(next); onChange(next)
  }
  return <div className="flex items-center gap-2 flex-wrap">
    <Select value={draft.preset} onValueChange={v => { if (v) preset(v as DateRangePreset) }}>
      <SelectTrigger aria-label="Período del dashboard" className="h-10 w-auto min-w-[150px] text-sm">
        <CalendarRange className="size-4 text-muted-foreground shrink-0" />
        <SelectValue>{draft.preset === 'custom' ? 'Personalizado' : DATE_RANGE_LABELS[draft.preset]}</SelectValue>
      </SelectTrigger>
      <SelectContent align="end">{(Object.keys(DATE_RANGE_LABELS) as DateRangePreset[]).map(p => <SelectItem key={p} value={p} className="text-xs">{DATE_RANGE_LABELS[p]}</SelectItem>)}</SelectContent>
    </Select>
    {draft.preset === 'custom' && <div className="flex items-center gap-2 flex-wrap">
      <Input type="date" value={draft.from} onChange={e => setDraft(d => ({ ...d, from: e.target.value }))} className="h-10 w-[144px] text-sm px-2.5" aria-label="Desde" aria-describedby="dashboard-range-from-hint" />
      <span id="dashboard-range-from-hint" className="sr-only">00:00</span>
      <span className="text-muted-foreground text-sm" aria-hidden="true">→</span>
      <Input type="date" value={draft.to} onChange={e => setDraft(d => ({ ...d, to: e.target.value }))} className="h-10 w-[144px] text-sm px-2.5" aria-label="Hasta" aria-describedby="dashboard-range-to-hint" />
      <span id="dashboard-range-to-hint" className="text-muted-foreground text-xs max-w-28 leading-snug">00:00 (no incluye ese día)</span>
      <Button size="sm" className="h-10" disabled={!valid || !pending} onClick={() => onChange(draft)}>Aplicar fechas</Button>
      {pending && <Button variant="ghost" size="sm" className="h-10" onClick={() => setDraft(value)}>Cancelar</Button>}
      {pending && <span role={valid ? 'status' : 'alert'} className={`text-xs ${valid ? 'text-muted-foreground' : 'text-destructive'}`}>
        {valid ? `Sin aplicar · ${describeDateRange(draft)}` : 'Completá ambas fechas; Desde debe ser anterior a Hasta (Hasta se toma a las 00:00 y no se incluye).'}
      </span>}
    </div>}
  </div>
}
