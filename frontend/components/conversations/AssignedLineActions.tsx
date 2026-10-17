'use client'
import { useState } from 'react'
import { Copy, ClipboardPaste, Phone, Link as LinkIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { assignedLineMessage, contactLineLabel, assignedLineDestination } from '@/lib/agent-line-types'
import type { Conv } from '@/lib/scoring/conversation-scoring'

export function AssignedLineActions({conv,onInsert,disabled=false}:{conv?:Conv;onInsert:(text:string)=>void;disabled?:boolean}) {
  const [status,setStatus] = useState('')
  const line = conv?.line_assignment_ambiguous ? null : conv?.assigned_line
  if (!line) return <p className="mb-2 text-xs text-muted-foreground">
    {conv?.line_assignment_ambiguous ? 'Revisá la línea asignada: este teléfono tiene contactos con asignaciones diferentes.'
      : conv?.linea != null ? `${conv.agent ? conv.agent + ' · ' : ''}${contactLineLabel(conv.linea,conv.linea_sub)} · Falta cargar o activar esta línea en Agentes para copiarla o pegarla.`
      : 'Este contacto no tiene una línea asignada.'}
  </p>
  const isLink = line.delivery_mode === 'link'
  const destination = assignedLineDestination(line)
  if (!destination) return <p className="mb-2 text-xs text-muted-foreground">{line.label} · Falta cargar el {isLink ? 'link' : 'número'} en Agentes. El agente está configurado para enviar {isLink ? 'link' : 'número'}.</p>
  const copy = async () => {
    try { await navigator.clipboard.writeText(destination); setStatus(isLink ? 'Link copiado' : 'Número copiado') }
    catch { setStatus('No se pudo copiar. Podés seleccionar el destino o pegarlo en la respuesta.') }
  }
  return <div className="mb-1 md:mb-2 rounded-lg border border-border bg-background px-2 py-1 md:px-3 md:py-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0 text-xs"><span className="flex items-center gap-1.5 font-medium">{isLink ? <LinkIcon size={12}/> : <Phone size={12}/>} {line.label}</span>
        <span className="block max-w-full select-text break-all font-mono text-muted-foreground">{destination}</span></div>
      <div className="flex shrink-0 gap-1">
        <Button size="sm" variant="outline" onClick={copy} aria-label={isLink ? 'Copiar link de la línea' : 'Copiar número de la línea'} title={isLink ? 'Copiar link de la línea' : 'Copiar número de la línea'}><Copy size={14}/><span className="hidden md:inline">Copiar</span></Button>
        <Button size="sm" variant="outline" disabled={disabled} aria-label="Pegar en respuesta" title="Pegar línea en respuesta" onClick={()=>{onInsert(assignedLineMessage(line));setStatus(isLink ? 'Link pegado en el borrador' : 'Línea pegada en el borrador')}}>
          <ClipboardPaste size={14}/><span className="hidden md:inline">Pegar en respuesta</span>
        </Button>
      </div>
    </div>
    {status && <p role="status" className="sr-only md:not-sr-only md:mt-1 text-xs text-muted-foreground">{status}</p>}
  </div>
}
