'use client'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { EMPTY_BROADCAST, broadcastError, broadcastLabel, type BroadcastRange } from '@/lib/broadcast-range'

export function BroadcastFilter({ value, onChange }: { value: BroadcastRange; onChange: (v: BroadcastRange) => void }) {
  const [open,setOpen] = useState(false)
  const [draft,setDraft] = useState(value)
  const id = useId(), error = broadcastError(draft)
  const selectClass = 'mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm'
  return <>
    <Button onClick={() => { setDraft(value.mode ? value : {...EMPTY_BROADCAST,mode:'not_sent'}); setOpen(true) }} type="button" variant={value.mode ? 'secondary' : 'outline'} className="h-9 font-normal">{broadcastLabel(value)}</Button>
    <Dialog open={open} onOpenChange={setOpen}>
    <DialogContent className="sm:max-w-sm space-y-2">
      <DialogTitle>Filtrar por difusión</DialogTitle>
      <label htmlFor={`${id}-mode`} className="block text-sm">Mostrar contactos
        <select id={`${id}-mode`} className={selectClass} value={draft.mode} onChange={e=>setDraft({...draft,mode:e.target.value as BroadcastRange['mode']})}>
          <option value="not_sent">No difundidos en el período</option><option value="sent">Difundidos en el período</option>
        </select>
      </label>
      <label htmlFor={`${id}-period`} className="block text-sm">Período
        <select id={`${id}-period`} className={selectClass} value={draft.period} onChange={e=>setDraft({...draft,period:e.target.value as BroadcastRange['period']})}>
          <option value="days">Últimos días</option><option value="dates">Fechas específicas</option>
        </select>
      </label>
      {draft.period === 'days' ? <label htmlFor={`${id}-days`} className="block text-sm">Cantidad de días
        <Input id={`${id}-days`} type="number" min={1} max={36500} step={1} value={draft.days} onChange={e=>setDraft({...draft,days:e.target.value})} />
      </label> : <div className="grid grid-cols-2 gap-2">
        <label htmlFor={`${id}-from`} className="text-sm">Desde<Input id={`${id}-from`} type="date" value={draft.from} onChange={e=>setDraft({...draft,from:e.target.value})} /></label>
        <label htmlFor={`${id}-to`} className="text-sm">Hasta<Input id={`${id}-to`} type="date" value={draft.to} onChange={e=>setDraft({...draft,to:e.target.value})} /></label>
      </div>}
      <p className="text-xs text-muted-foreground">Cuenta envíos de campañas registrados como enviados, entregados o leídos, en cualquier línea. Excluye fallidos, pendientes y chats individuales. “No difundidos” incluye contactos sin envíos registrados.</p>
      <p className="text-xs text-muted-foreground">{draft.period === 'days' ? 'Se cuentan períodos de 24 horas hasta ahora.' : 'Incluye ambas fechas completas, en horario de Argentina. Para un solo día, elegí la misma fecha.'}</p>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" size="sm" onClick={()=>{onChange(EMPTY_BROADCAST);setOpen(false)}}>Limpiar difusión</Button>
        <Button type="button" size="sm" disabled={!!error} onClick={()=>{onChange(draft);setOpen(false)}}>Aplicar difusión</Button></div>
    </DialogContent>
    </Dialog>
  </>
}
