'use client'
import { useState } from 'react'
import { FileText, ChevronDown } from 'lucide-react'

interface Template { id: string; label: string; text: string }

const TEMPLATES: Template[] = [
  {
    id:    'welcome',
    label: 'Bienvenida + Bono',
    text:  'Hola {nombre}! Te damos la bienvenida. Como regalo, tenés {bono} esperándote en tu cuenta. ¡Empezá a jugar hoy!',
  },
  {
    id:    'deposit_reminder',
    label: 'Recordatorio de depósito',
    text:  'Hola {nombre}, notamos que tenés saldo disponible. ¿Necesitás ayuda para realizar una carga? Estamos para asistirte.',
  },
  {
    id:    'vip_offer',
    label: 'Oferta VIP',
    text:  'Estimado/a {nombre}, como cliente VIP tenés acceso a beneficios exclusivos esta semana. Contactame para conocer tu oferta personalizada.',
  },
  {
    id:    'complaint',
    label: 'Manejo de queja',
    text:  'Hola {nombre}, lamentamos que hayas tenido esta experiencia. Vamos a revisar tu caso de inmediato. ¿Podés contarme más detalles?',
  },
  {
    id:    'reactivation',
    label: 'Reactivación',
    text:  'Hola {nombre}! Hace tiempo que no te vemos. Tenemos una oferta especial preparada para vos. ¿Te gustaría saber más?',
  },
]

function applyVars(text: string, name: string | null | undefined): string {
  return text
    .replace(/\{nombre\}/g, name || 'Cliente')
    .replace(/\{bono\}/g,   '$20.000')
}

interface Props {
  contactName?: string | null
  onSelect:     (text: string) => void
}

export function QuickTemplates({ contactName, onSelect }: Props) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className={`flex items-center gap-1 text-xs border rounded px-2 py-1.5 transition-colors ${
          open
            ? 'border-indigo-400 text-indigo-600 bg-indigo-50'
            : 'border-gray-200 text-gray-500 hover:border-gray-400 hover:text-gray-700'
        }`}
      >
        <FileText size={12} />
        Plantillas
        <ChevronDown size={11} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full mb-1.5 left-0 w-72 bg-white border border-gray-200 rounded-lg shadow-xl z-50 overflow-hidden">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide px-3 pt-2.5 pb-1">
              Plantillas rápidas
            </p>
            {TEMPLATES.map(t => (
              <button
                key={t.id}
                onClick={() => { onSelect(applyVars(t.text, contactName)); setOpen(false) }}
                className="w-full text-left px-3 py-2.5 hover:bg-gray-50 border-t border-gray-50 transition-colors"
              >
                <p className="text-xs font-medium text-gray-700">{t.label}</p>
                <p className="text-[10px] text-gray-400 truncate mt-0.5">
                  {applyVars(t.text, contactName).slice(0, 65)}…
                </p>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
