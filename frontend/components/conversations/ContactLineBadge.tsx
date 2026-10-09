import { Phone } from 'lucide-react'
import type { Conv } from '@/lib/scoring/conversation-scoring'
import { contactLineLabel } from '@/lib/agent-line-types'
export function ContactLineBadge({conv}:{conv?:Conv}) {
  const label = conv?.line_assignment_ambiguous ? 'Revisar línea' : contactLineLabel(conv?.linea,conv?.linea_sub)
  return <span title={conv?.line_assignment_ambiguous ? 'Este teléfono tiene asignaciones diferentes. Revisá el contacto.' : `Línea asignada: ${label}`}
    className="inline-flex items-center gap-1 rounded border border-orange-200 bg-orange-50 px-1.5 py-0.5 text-[10px] font-medium text-orange-800">
    <Phone size={10} aria-hidden="true" />{label}
  </span>
}
