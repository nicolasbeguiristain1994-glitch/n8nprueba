'use client'
import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MessageSquare, Send, AlertCircle, Eye, Wifi, Clock, BarChart2, Shield } from 'lucide-react'

interface Stats {
  total: string; sent: string; failed: string; delivered: string
  read: string; inbound: string; last_24h: string; read_rate: string
}
interface CampaignStats { total: number; sent: number; sending: number; scheduled: number }
interface Line {
  line_key: string; display_name: string; status: string
  is_connected: boolean; msgs_sent_today: number; msg_per_day: number
  evolution_instance: string
}
interface Message {
  phone_number: string; message_body: string
  direction: string; status: string; created_at: string
}

export default function Dashboard() {
  const [stats, setStats]     = useState<Stats | null>(null)
  const [lines, setLines]     = useState<Line[]>([])
  const [recent, setRecent]   = useState<Message[]>([])
  const [cs, setCs]           = useState<CampaignStats | null>(null)

  useEffect(() => {
    fetch('/api/dashboard').then(r => r.json()).then(d => {
      setStats(d.stats); setLines(d.lines); setRecent(d.recent); setCs(d.campaignStats)
    })
  }, [])

  const s = stats

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Dashboard</h1>
          <p className="text-sm text-gray-500">Resumen en tiempo real</p>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-green-600 bg-green-50 px-2 py-1 rounded-full">
          <Shield size={12}/> Antibloqueo activo
        </div>
      </div>

      {/* Métricas principales */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard icon={<Send size={18} className="text-blue-500"/>}
          label="Enviados (total)" value={s?.sent ?? '—'} />
        <MetricCard icon={<Eye size={18} className="text-purple-500"/>}
          label="Leídos" value={s?.read ?? '—'}
          sub={s?.read_rate ? `${s.read_rate}% tasa de lectura` : undefined} />
        <MetricCard icon={<MessageSquare size={18} className="text-green-500"/>}
          label="Entrantes" value={s?.inbound ?? '—'} />
        <MetricCard icon={<AlertCircle size={18} className="text-red-500"/>}
          label="Fallidos" value={s?.failed ?? '—'} bad={Number(s?.failed) > 0} />
      </div>

      {/* Campañas */}
      {cs && (
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: 'Campañas totales',    value: cs.total,     color: 'gray' },
            { label: 'Enviadas',            value: cs.sent,      color: 'green' },
            { label: 'Enviando ahora',      value: cs.sending,   color: 'yellow' },
            { label: 'Programadas',         value: cs.scheduled, color: 'blue' },
          ].map(({ label, value, color }) => (
            <Card key={label}>
              <CardContent className="pt-4 pb-3">
                <p className={`text-xl font-bold ${
                  color==='green'?'text-green-600':color==='yellow'?'text-yellow-600':color==='blue'?'text-blue-600':''
                }`}>{value}</p>
                <p className="text-xs text-gray-500 mt-0.5">{label}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Líneas */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Wifi size={15}/> Líneas activas
            </CardTitle>
          </CardHeader>
          <CardContent>
            {lines.length === 0
              ? <p className="text-sm text-gray-400">Sin líneas activas</p>
              : <div className="space-y-2">
                  {lines.map(l => {
                    const pct = l.msg_per_day ? (l.msgs_sent_today / l.msg_per_day) * 100 : 0
                    return (
                      <div key={l.line_key} className="py-1.5 border-b border-gray-100 last:border-0">
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2">
                            <span className={`w-2 h-2 rounded-full ${l.is_connected ? 'bg-green-500' : 'bg-gray-300'}`}/>
                            <span className="text-sm">{l.display_name || l.evolution_instance}</span>
                          </div>
                          <span className="text-xs text-gray-500">{l.msgs_sent_today}/{l.msg_per_day}</span>
                        </div>
                        <div className="w-full bg-gray-100 rounded-full h-1">
                          <div className="bg-green-400 h-1 rounded-full" style={{width:`${Math.min(pct,100)}%`}}/>
                        </div>
                      </div>
                    )
                  })}
                </div>
            }
          </CardContent>
        </Card>

        {/* Actividad */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Clock size={15}/> Actividad reciente
            </CardTitle>
          </CardHeader>
          <CardContent>
            {recent.length === 0
              ? <p className="text-sm text-gray-400">Sin mensajes aún</p>
              : <div className="space-y-1">
                  {recent.map((m, i) => (
                    <div key={i} className="flex items-start gap-2 py-1.5 border-b border-gray-100 last:border-0">
                      <Badge variant={m.direction === 'inbound' ? 'secondary' : 'outline'} className="text-xs shrink-0 mt-0.5">
                        {m.direction === 'inbound' ? '↓' : '↑'}
                      </Badge>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-gray-500">{m.phone_number}</p>
                        <p className="text-sm truncate">{m.message_body}</p>
                      </div>
                      <span className={`text-xs shrink-0 ${
                        m.status==='read'?'text-purple-500':m.status==='delivered'?'text-green-500':m.status==='failed'?'text-red-400':'text-gray-400'
                      }`}>
                        {m.status==='read'?'leído':m.status==='delivered'?'entregado':m.status==='failed'?'fallido':m.status}
                      </span>
                    </div>
                  ))}
                </div>
            }
          </CardContent>
        </Card>
      </div>

      {/* Stats de lectura */}
      {s && Number(s.read_rate) > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <BarChart2 size={15}/> Tasa de lectura global
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <div className="flex justify-between text-xs text-gray-500 mb-1">
                  <span>Leídos vs Enviados</span><span>{s.read_rate}%</span>
                </div>
                <div className="w-full bg-gray-100 rounded-full h-3">
                  <div className="bg-purple-500 h-3 rounded-full" style={{width:`${Math.min(Number(s.read_rate),100)}%`}}/>
                </div>
              </div>
              <div className="text-right shrink-0">
                <p className="text-2xl font-bold text-purple-600">{s.read_rate}%</p>
                <p className="text-xs text-gray-400">{s.read} de {s.sent}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function MetricCard({ icon, label, value, bad, sub }: {
  icon: React.ReactNode; label: string; value: string|number; bad?: boolean; sub?: string
}) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-center gap-2 mb-1">{icon}<span className="text-xs text-gray-500">{label}</span></div>
        <p className={`text-2xl font-bold ${bad ? 'text-red-600' : ''}`}>{value}</p>
        {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  )
}
