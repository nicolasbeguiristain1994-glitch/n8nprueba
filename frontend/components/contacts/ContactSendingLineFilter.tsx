'use client'
import type { ContactSendingLine } from '@/lib/contact-sending-lines'
import { Button } from '@/components/ui/button'

export function ContactSendingLineFilter({line,mode,lines,error,onChange,onRetry}: {
  line:string; mode:'assigned'|'other'; lines:ContactSendingLine[]; error:string|null
  onChange:(line:string,mode:'assigned'|'other')=>void; onRetry:()=>void
}) {
  return <section aria-label="Filtro de línea de envío" className="space-y-2 rounded-lg border border-primary/20 bg-primary/5 p-3">
    <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-0 space-y-1 text-sm font-medium">Línea de envío
        <select aria-label="Línea de envío" value={line} onChange={e=>onChange(e.target.value,'assigned')}
          className="block h-9 w-full max-w-full rounded-md border bg-background px-2 font-normal sm:w-80">
          <option value="">Todas las líneas de envío</option>
          <option value="unassigned">Sin asignación previa</option>
          {line&&line!=='unassigned'&&!lines.some(item=>item.id===line)&&<option value={line}>Línea seleccionada no disponible</option>}
          {lines.map(item=><option key={item.id} value={item.id}>{item.name}{item.phone?` · ${item.phone}`:''}</option>)}
        </select>
      </label>
      {line&&line!=='unassigned'&&<label className="space-y-1 text-sm font-medium">Mostrar
        <select aria-label="Asignación de línea de envío" value={mode} onChange={e=>onChange(line,e.target.value as 'assigned'|'other')}
          className="block h-9 max-w-full rounded-md border bg-background px-2 font-normal">
          <option value="assigned">Asignados a esta línea</option>
          <option value="other">Asignados a otras líneas</option>
        </select>
      </label>}
      {line&&<Button type="button" size="sm" variant="ghost" onClick={()=>onChange('','assigned')}>Quitar filtro de envío</Button>}
    </div>
    <p className="text-xs leading-relaxed text-muted-foreground">
      {!line ? 'Elegí el número de WhatsApp que usará la campaña. La columna Línea de envío muestra la asignación que conserva cada contacto.'
        : line==='unassigned' ? 'Estos contactos todavía no tienen una línea habitual. La campaña los repartirá entre las líneas compatibles con la plantilla.'
        : mode==='other' ? 'Estás revisando contactos asignados a otras líneas. Volvé a «Asignados a esta línea» antes de crear la campaña.'
        : 'Solo se incluyen contactos asignados a esta línea; quedan fuera los de otras líneas y los que aún no tienen asignación. Usá una plantilla compatible y revisá el cupo antes de programar.'}
    </p>
    {error&&<div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">{error}<Button type="button" size="sm" variant="outline" onClick={onRetry}>Reintentar líneas</Button></div>}
  </section>
}
