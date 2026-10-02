'use client'

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatPesos } from '@/lib/dashboard-format'
import type { CampaignEffectiveness, EffectiveRecipient } from '@/lib/campaign-effectiveness'

const PLATFORM_LABELS: Record<string, string> = { zeus: 'Zeus', bet30: 'Bet30', ganamos: 'Ganamos', argenbet: 'Argenbet' }

function dateTime(value: string) {
  return new Date(value).toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires', dateStyle: 'short', timeStyle: 'short',
  })
}

export function CampaignEffectivenessPanel({ stats, recipients }: {
  stats: Omit<CampaignEffectiveness, 'efectivos_detalle'>
  recipients: EffectiveRecipient[]
}) {
  const [page, setPage] = useState(0)
  const pageSize = 20
  const pages = Math.max(1, Math.ceil(recipients.length / pageSize))
  const currentPage = Math.min(page, pages - 1)
  return (
    <Card className="border border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Efectividad de la campaña · 24 horas</CardTitle>
        <p className="text-xs text-muted-foreground">
          Un destinatario es efectivo si registra una carga después de su envío y hasta 24 horas después.
          Cada destinatario cuenta una vez. La tasa se calcula sobre los enviados.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          {[
            { label: 'Usuarios efectivos', value: stats.efectivos.toLocaleString('es-AR'), sub: 'Con carga confirmada en 24 h' },
            { label: 'Tasa de efectividad', value: stats.tasa_efectividad == null ? '—' : `${stats.tasa_efectividad}%`, sub: 'Efectivos / enviados' },
            { label: 'Monto cargado · 24 h', value: formatPesos(stats.monto_cargado_24h), sub: `${stats.cargas_24h.toLocaleString('es-AR')} cargas, sin bonos` },
            { label: 'Monto apostado · 24 h', value: 'No disponible', sub: 'La integración actual registra cargas y retiros, no apuestas.' },
          ].map(item => (
            <div key={item.label} className="rounded-lg bg-muted/40 p-4 min-w-0">
              <p className="text-xs text-muted-foreground">{item.label}</p>
              <p className="text-xl font-semibold mt-1 break-words">{item.value}</p>
              <p className="text-xs text-muted-foreground mt-1">{item.sub}</p>
            </div>
          ))}
        </div>
        <div className="text-xs text-muted-foreground space-y-1">
          <p>Calculado con las cargas sincronizadas. Cada campaña se evalúa por separado; una carga puede coincidir con la ventana de otra campaña.</p>
          {stats.ventanas_abiertas > 0 && <p>{stats.ventanas_abiertas} destinatarios todavía están dentro de sus 24 horas. El resultado es provisional.</p>}
          {stats.sin_cuenta > 0 && <p>{stats.sin_cuenta} enviados sin cuenta de casino vinculada: no se pueden verificar sus cargas.</p>}
          {stats.sin_hora_envio > 0 && <p>{stats.sin_hora_envio} enviados sin hora de envío disponible: no se les atribuyen cargas.</p>}
          {stats.cargas_sin_hora > 0 && <p>{stats.cargas_sin_hora} cargas en las fechas de la ventana no tienen hora exacta y quedan excluidas de la efectividad.</p>}
        </div>
        {recipients.length === 0 ? (
          <p className="text-sm text-muted-foreground py-3">Todavía no hay usuarios efectivos confirmados en esta campaña.</p>
        ) : (
          <div className="space-y-3">
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <caption className="text-left p-3 font-medium">Destinatarios efectivos</caption>
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>{['Contacto', 'Usuario', 'Plataforma', 'Resultado', 'Enviado', 'Primera carga', 'Cargas', 'Monto cargado · 24 h'].map(label => (
                    <th key={label} className="px-3 py-2 text-left font-medium whitespace-nowrap">{label}</th>
                  ))}</tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {recipients.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(recipient => (
                    <tr key={recipient.recipient_id}>
                      <td className="px-3 py-2 whitespace-nowrap">{recipient.phone_number}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {recipient.cuentas_carga?.length ? recipient.cuentas_carga.map(account => (
                          <div key={`${account.plataforma}:${account.usuario}`}>{account.usuario}</div>
                        )) : '—'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {recipient.cuentas_carga?.length ? recipient.cuentas_carga.map(account => (
                          <div key={`${account.plataforma}:${account.usuario}`}>{PLATFORM_LABELS[account.plataforma] ?? account.plataforma}</div>
                        )) : '—'}
                      </td>
                      <td className="px-3 py-2"><Badge className="bg-success/15 text-success">Efectivo</Badge></td>
                      <td className="px-3 py-2 whitespace-nowrap">{dateTime(recipient.sent_at)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{dateTime(recipient.primera_carga)}</td>
                      <td className="px-3 py-2">{recipient.cargas}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{formatPesos(recipient.monto_cargado)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pages > 1 && <div className="flex items-center justify-end gap-3 text-xs text-muted-foreground">
              <Button variant="outline" size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Anterior</Button>
              <span>Página {currentPage + 1} de {pages}</span>
              <Button variant="outline" size="sm" disabled={currentPage + 1 === pages} onClick={() => setPage(currentPage + 1)}>Siguiente</Button>
            </div>}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
