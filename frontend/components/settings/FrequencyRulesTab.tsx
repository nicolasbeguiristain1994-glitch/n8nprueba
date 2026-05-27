'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { AlertCircle, AlertTriangle, Loader2 } from 'lucide-react'

type FrequencyRule = {
  id: string
  operator_id: string | null
  operator_email: string | null
  seg_monto: string | null
  seg_actividad: string | null
  max_per_day: number
  max_per_week: number
  min_hours_between_sends: number
  is_active: boolean
  created_at: string
  specificity: number
}

export function FrequencyRulesTab() {
  const [rules, setRules]           = useState<FrequencyRule[]>([])
  const [loading, setLoading]       = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/settings/frequency-rules')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<{ rules: FrequencyRule[] }>
      })
      .then(d => { setRules(d.rules); setLoading(false) })
      .catch(() => { setFetchError('Error al cargar las reglas de frecuencia'); setLoading(false) })
  }, [])

  function scopeLabel(rule: FrequencyRule): string {
    if (!rule.operator_id && !rule.seg_monto && !rule.seg_actividad) return 'Global (todas)'
    const parts: string[] = []
    if (rule.operator_email) parts.push(rule.operator_email)
    if (rule.seg_monto)     parts.push(`monto: ${rule.seg_monto}`)
    if (rule.seg_actividad) parts.push(`actividad: ${rule.seg_actividad}`)
    return parts.join(' · ')
  }

  if (loading) return (
    <div className="flex items-center justify-center h-32">
      <Loader2 size={20} className="animate-spin text-gray-400" />
    </div>
  )

  if (fetchError) return (
    <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
      <AlertCircle size={16} className="shrink-0" /> {fetchError}
    </div>
  )

  return (
    <div className="space-y-4">
      {/* Banner solo lectura */}
      <div className="flex items-start gap-2 bg-yellow-50 border border-yellow-200 rounded-lg px-4 py-3 text-sm text-yellow-800">
        <AlertTriangle size={16} className="shrink-0 mt-0.5" />
        <span>
          La edición de reglas de frecuencia estará disponible en la próxima versión.
          Hoy estos valores solo pueden modificarse directamente en la base de datos.
        </span>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Reglas de Frecuencia de Contacto</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left py-2 pr-4 font-medium text-gray-500 text-xs uppercase tracking-wide">Alcance</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-500 text-xs uppercase tracking-wide">Esp.</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-500 text-xs uppercase tracking-wide">Máx/día</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-500 text-xs uppercase tracking-wide">Máx/semana</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-500 text-xs uppercase tracking-wide">Min horas</th>
                </tr>
              </thead>
              <tbody>
                {rules.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-gray-400 text-sm">
                      No hay reglas configuradas
                    </td>
                  </tr>
                ) : (
                  rules.map(rule => {
                    const isGlobal = !rule.operator_id && !rule.seg_monto && !rule.seg_actividad
                    return (
                      <tr
                        key={rule.id}
                        className={`border-b border-gray-50 last:border-0 ${isGlobal ? 'bg-blue-50/40' : 'hover:bg-gray-50/50'}`}
                      >
                        <td className="py-2.5 pr-4">
                          <span className="text-sm text-gray-700">
                            {scopeLabel(rule)}
                          </span>
                          {isGlobal && (
                            <span className="ml-2 text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                              Fallback global
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-right text-gray-500 text-xs">{rule.specificity}</td>
                        <td className="py-2.5 px-3 text-right font-medium">{rule.max_per_day}</td>
                        <td className="py-2.5 px-3 text-right font-medium">{rule.max_per_week}</td>
                        <td className="py-2.5 px-3 text-right font-medium">{rule.min_hours_between_sends}h</td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-400 mt-3">
            Especificidad: 0 = global, 7 = máximo (operador + seg. monto + seg. actividad).
            La regla más específica que aplica al contexto tiene precedencia.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
