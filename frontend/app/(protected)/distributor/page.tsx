'use client'
import { useEffect, useState, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RefreshCw, Server, Activity, Globe, RotateCw, Plus, AlertTriangle } from 'lucide-react'
import { fetchJson } from '@/lib/fetchJson'

// ── Types ──────────────────────────────────────────────────────────────────────

interface DistributorStats {
  lines: { total: number; eligible: number; with_proxy: number }
  proxies: {
    total: number; healthy: number; degraded: number
    unhealthy: number; unknown: number; unassigned: number
  }
}

interface ProxyRow {
  id: string; label: string; host: string; port: number
  protocol: string; country: string | null; region: string | null
  proxy_type: string; health_status: string; latency_ms: number | null
  bans_detected: number; rotating_endpoint: boolean; is_active: boolean
  sticky_line_id: string | null; notes: string | null
  assigned_lines: number
  updated_at: string
}

interface AssignResult {
  line: {
    id: string; display_name: string; line_key: string
    priority: number; avg_delivery_rate: number
    msgs_sent_today: number; msg_per_day: number
  }
  score: { total: number; reputation: number; capacity: number; priority: number; proxy_health: number }
  proxy: ProxyRow | null
  proxyAction: 'keep' | 'replace' | 'none'
}

// ── Health badge helpers ───────────────────────────────────────────────────────

function healthVariant(h: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (h) {
    case 'healthy':   return 'default'
    case 'degraded':  return 'secondary'
    case 'unhealthy': return 'destructive'
    default:          return 'outline'
  }
}

function proxyTypeBadge(t: string) {
  const labels: Record<string, string> = {
    datacenter: 'DC', residential: 'Res', mobile: 'Mob'
  }
  return labels[t] ?? t
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DistributorPage() {
  const [stats,   setStats]   = useState<DistributorStats | null>(null)
  const [proxies, setProxies] = useState<ProxyRow[]>([])
  const [preview, setPreview] = useState<AssignResult[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [rotating, setRotating] = useState<string | null>(null)
  const [error, setError]     = useState<string | null>(null)

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [s, p] = await Promise.all([
        fetchJson<DistributorStats>('/api/distributor/stats'),
        fetchJson<{ proxies: ProxyRow[] }>('/api/proxies'),
      ])
      setStats(s)
      setProxies(p.proxies ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error cargando datos')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  const runPreview = async () => {
    setPreview(null)
    try {
      const res = await fetchJson<{ results: AssignResult[] }>(
        '/api/distributor/assign',
        { method: 'POST', body: JSON.stringify({ topN: 5 }) }
      )
      setPreview(res.results ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error en preview')
    }
  }

  const rotateProxy = async (lineId: string) => {
    setRotating(lineId)
    try {
      await fetchJson(`/api/distributor/rotate-proxy/${lineId}`, { method: 'POST' })
      await loadAll()
      setPreview(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error rotando proxy')
    } finally {
      setRotating(null)
    }
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Distribuidor de Líneas</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Asignación operacional de líneas y proxies para campañas
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={loadAll} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            <span className="ml-1.5">Actualizar</span>
          </Button>
          <Button size="sm" onClick={runPreview} disabled={loading}>
            <Activity size={14} className="mr-1.5" />
            Vista previa de asignación
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle size={14} />
          {error}
        </div>
      )}

      {/* Stats row */}
      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard title="Líneas totales"    value={stats.lines.total}      icon={<Server size={16} />} />
          <StatCard title="Líneas elegibles"  value={stats.lines.eligible}   icon={<Activity size={16} className="text-green-600" />} />
          <StatCard title="Líneas con proxy"  value={stats.lines.with_proxy} icon={<Globe size={16} />} />
          <StatCard title="Proxies activos"   value={stats.proxies.total}    icon={<Server size={16} />}>
            <div className="flex gap-1 mt-1 flex-wrap">
              {stats.proxies.healthy   > 0 && <Badge variant="default"     className="text-xs">{stats.proxies.healthy} ok</Badge>}
              {stats.proxies.degraded  > 0 && <Badge variant="secondary"   className="text-xs">{stats.proxies.degraded} deg</Badge>}
              {stats.proxies.unhealthy > 0 && <Badge variant="destructive" className="text-xs">{stats.proxies.unhealthy} down</Badge>}
              {stats.proxies.unknown   > 0 && <Badge variant="outline"     className="text-xs">{stats.proxies.unknown} ?</Badge>}
            </div>
          </StatCard>
        </div>
      )}

      {/* Assignment preview */}
      {preview !== null && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Vista previa — top líneas (modo advisory, sin cambios)</CardTitle>
          </CardHeader>
          <CardContent>
            {preview.length === 0 ? (
              <p className="text-sm text-gray-500">No hay líneas elegibles en este momento.</p>
            ) : (
              <div className="space-y-3">
                {preview.map((r, i) => (
                  <div key={r.line.id} className="flex items-center gap-4 rounded-lg border border-gray-100 bg-gray-50 px-4 py-3">
                    <span className="text-xs font-mono text-gray-400 w-4">#{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{r.line.display_name}</p>
                      <p className="text-xs text-gray-500">{r.line.line_key}</p>
                    </div>
                    <ScoreBar score={r.score} />
                    {r.proxy ? (
                      <div className="text-xs text-right">
                        <Badge variant={healthVariant(r.proxy.health_status)} className="text-xs">
                          {r.proxy.health_status}
                        </Badge>
                        <p className="text-gray-500 mt-0.5">{r.proxy.label}</p>
                      </div>
                    ) : (
                      <span className="text-xs text-gray-400">sin proxy</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Proxy list */}
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium">Proxies registrados</CardTitle>
          <Button variant="outline" size="sm" disabled>
            <Plus size={13} className="mr-1" />
            Agregar proxy
          </Button>
        </CardHeader>
        <CardContent>
          {proxies.length === 0 ? (
            <p className="text-sm text-gray-500 py-4 text-center">
              No hay proxies registrados. Crear desde la API o la migración 024.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-xs text-gray-500">
                    <th className="text-left pb-2 pr-4 font-medium">Label</th>
                    <th className="text-left pb-2 pr-4 font-medium">Host:Puerto</th>
                    <th className="text-left pb-2 pr-4 font-medium">País / Tipo</th>
                    <th className="text-left pb-2 pr-4 font-medium">Salud</th>
                    <th className="text-right pb-2 pr-4 font-medium">Latencia</th>
                    <th className="text-right pb-2 pr-4 font-medium">Líneas</th>
                    <th className="text-left pb-2 font-medium">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {proxies.map(p => (
                    <tr key={p.id} className="hover:bg-gray-50">
                      <td className="py-2 pr-4 font-medium">{p.label}</td>
                      <td className="py-2 pr-4 text-gray-600 font-mono text-xs">
                        {p.host}:{p.port}
                        <span className="ml-1 text-gray-400">({p.protocol})</span>
                      </td>
                      <td className="py-2 pr-4">
                        <span className="text-gray-600">{p.country ?? '—'}</span>
                        <Badge variant="outline" className="ml-1.5 text-xs">{proxyTypeBadge(p.proxy_type)}</Badge>
                        {p.rotating_endpoint && <Badge variant="outline" className="ml-1 text-xs">rot</Badge>}
                      </td>
                      <td className="py-2 pr-4">
                        <Badge variant={healthVariant(p.health_status)} className="text-xs">
                          {p.health_status}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4 text-right text-gray-600">
                        {p.latency_ms != null ? `${p.latency_ms}ms` : '—'}
                      </td>
                      <td className="py-2 pr-4 text-right">
                        {p.assigned_lines > 0 ? (
                          <Badge variant="secondary" className="text-xs">{p.assigned_lines}</Badge>
                        ) : (
                          <span className="text-gray-400 text-xs">—</span>
                        )}
                      </td>
                      <td className="py-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          disabled={rotating !== null}
                          onClick={() => {
                            // Rotate proxy for each line that uses this proxy
                            // (For now, notify operator to use per-line rotate)
                            alert(`Para rotar, usa el botón en la fila de la línea específica.\nProxy ID: ${p.id}`)
                          }}
                        >
                          <RotateCw size={12} className="mr-1" />
                          Rotar
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatCard({
  title, value, icon, children
}: {
  title: string; value: number; icon: React.ReactNode; children?: React.ReactNode
}) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-center justify-between">
          <p className="text-xs text-gray-500">{title}</p>
          <span className="text-gray-400">{icon}</span>
        </div>
        <p className="text-2xl font-semibold mt-1">{value}</p>
        {children}
      </CardContent>
    </Card>
  )
}

function ScoreBar({ score }: { score: AssignResult['score'] }) {
  const pct = Math.max(0, Math.min(100, score.total))
  const color = pct >= 70 ? 'bg-green-500' : pct >= 40 ? 'bg-yellow-500' : 'bg-red-500'
  return (
    <div className="flex flex-col items-center gap-0.5 w-20">
      <div className="w-full h-1.5 rounded-full bg-gray-200">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-500">{score.total}/100</span>
    </div>
  )
}
