'use client'
import { useState } from 'react'
import { Copy, ClipboardPaste, Phone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { assignedLineMessage, contactLineLabel } from '@/lib/agent-line-types'
import type { Conv } from '@/lib/scoring/conversation-scoring'

export function AssignedLineActions({conv,onInsert,disabled=false}:{conv?:Conv;onInsert:(text:string)=>void;disabled?:boolean}) {
  const [status,setStatus] = useState('')
  const line = conv?.line_assignment_ambiguous ? null : conv?.assigned_line
  if (!line) return <p className="mb-2 text-xs text-muted-foreground">
    {conv?.line_assignment_ambiguous ? 'Revisá la línea asignada: este teléfono tiene contactos con asignaciones diferentes.'
      : conv?.linea != null ? `${contactLineLabel(conv.linea,conv.linea_sub)} · Teléfono no cargado o línea inactiva.`
      : 'Este contacto no tiene una línea asignada.'}
  </p>
  const copy = async () => {
    try { await navigator.clipboard.writeText(line.phone); setStatus('Número copiado') }
    catch { setStatus('No se pudo copiar. Podés seleccionar el número o pegarlo en la respuesta.') }
  }
  return <div className="mb-2 rounded-lg border border-border bg-background px-3 py-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0 text-xs"><span className="flex items-center gap-1.5 font-medium"><Phone size={12}/>{line.label}</span>
        <span className="select-text font-mono text-muted-foreground">{line.phone}</span></div>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="outline" onClick={copy} aria-label="Copiar número de la línea"><Copy size={12}/>Copiar</Button>
        <Button size="sm" variant="outline" disabled={disabled} onClick={()=>{onInsert(assignedLineMessage(line));setStatus('Línea pegada en el borrador')}}>
          <ClipboardPaste size={12}/>Pegar en respuesta
        </Button>
      </div>
    </div>
    {status && <p role="status" className="mt-1 text-xs text-muted-foreground">{status}</p>}
  </div>
}
