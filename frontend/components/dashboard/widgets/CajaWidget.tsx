'use client'

import { memo, useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Wallet, ChevronLeft, ChevronRight, BookOpen, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CajaRow, CajaTotals } from '@/app/api/dashboard/caja/route'

import { formatPesos, formatProviderPesos } from '@/lib/dashboard-format'
import { describeDateRange, queryDateRange } from '@/lib/dashboard-date-range'
import type { Platform } from '@/lib/casino-agents'
import type { DateRange } from '../types'

function fmtDateTime(row: CajaRow): string {
  if (row.fecha_hora_utc) {
    // Convert UTC → Argentina time (UTC-3)
    const d = new Date(row.fecha_hora_utc)
    return d.toLocaleString('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).replace(',', '')
  }
  return row.fecha
}

const fmtMoney = formatPesos
const PLATFORM_LABELS: Record<string, string> = { zeus: 'Zeus', bet30: 'Bet30', ganamos: 'Ganamos', argenbet: 'Argenbet', consolidado: 'Todas' }

// ── Hook ───────────────────────────────────────────────────────────────────────

interface CajaState {
  rows:     CajaRow[]
  total:    number
  totals:   CajaTotals | null
  loading:  boolean
  error: string | null
}

interface CajaParams {
  enabled: boolean
  from:     string
  to:       string
  platform: Platform
  agent: string
  revision: number
  search:   string
  searchBy: 'username' | 'agente'
  page:     number
}

function useCajaData(params: CajaParams): CajaState {
  const [rows,    setRows]    = useState<CajaRow[]>([])
  const [total,   setTotal]   = useState(0)
  const [totals,  setTotals]  = useState<CajaTotals | null>(null)
  const [loading, setLoading] = useState(false)

  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    if (!params.enabled) return
    const qs = new URLSearchParams({ from: params.from, to: params.to, platform: params.platform,
      agent: params.agent, page: String(params.page), per_page: '20', search: params.search, search_by: params.searchBy })
    async function load() {
      try {
        const res = await fetch(`/api/dashboard/caja?${qs}`, { signal: controller.signal, cache: 'no-store' })
        if (!res.ok) throw new Error('No se pudo consultar Caja. Reintentá con Refrescar vista.')
        const data = await res.json()
        if (controller.signal.aborted) return
        setRows(data.rows ?? []); setTotal(data.total ?? 0); setTotals(data.totals ?? null)
      } catch (e) {
        if (!controller.signal.aborted) {
          setRows([]); setTotal(0); setTotals(null)
          setError(e instanceof Error ? e.message : 'No se pudo consultar Caja')
        }
      } finally { if (!controller.signal.aborted) setLoading(false) }
    }
    const timer = setTimeout(() => { void load() }, 180)
    return () => { clearTimeout(timer); controller.abort() }
  }, [params.from, params.to, params.platform, params.agent, params.search, params.searchBy, params.page, params.revision, params.enabled])
  return { rows, total, totals, loading, error }
}

// ── Skeleton ───────────────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="space-y-1.5 pt-1">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="h-10 rounded bg-muted animate-pulse" />
      ))}
    </div>
  )
}

// ── Pagination ─────────────────────────────────────────────────────────────────

interface PaginationProps {
  page:     number
  total:    number
  perPage:  number
  onChange: (p: number) => void
}

function Pagination({ page, total, perPage, onChange }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / perPage))
  if (totalPages <= 1) return null

  // Show up to 7 page buttons around current page
  const range: number[] = []
  const delta = 3
  for (let i = Math.max(1, page - delta); i <= Math.min(totalPages, page + delta); i++) {
    range.push(i)
  }

  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-border text-xs">
      <span className="text-muted-foreground">
        {total.toLocaleString('es-AR')} registros · pág {page} de {totalPages}
      </span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onChange(1)}
          disabled={page === 1}
          className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Primera página"
        >
          «
        </button>
        <button
          onClick={() => onChange(page - 1)}
          disabled={page === 1}
          className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Página anterior"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>

        {range[0] > 1 && (
          <>
            <button onClick={() => onChange(1)} className="px-2 py-0.5 rounded hover:bg-muted">1</button>
            {range[0] > 2 && <span className="px-1 text-muted-foreground">…</span>}
          </>
        )}
        {range.map(p => (
          <button
            key={p}
            onClick={() => onChange(p)}
            className={cn(
              'px-2 py-0.5 rounded min-w-[24px] text-center',
              p === page
                ? 'bg-primary text-primary-foreground font-semibold'
                : 'hover:bg-muted',
            )}
          >
            {p}
          </button>
        ))}
        {range[range.length - 1] < totalPages && (
          <>
            {range[range.length - 1] < totalPages - 1 && <span className="px-1 text-muted-foreground">…</span>}
            <button onClick={() => onChange(totalPages)} className="px-2 py-0.5 rounded hover:bg-muted">
              {totalPages}
            </button>
          </>
        )}

        <button
          onClick={() => onChange(page + 1)}
          disabled={page === totalPages}
          className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Página siguiente"
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => onChange(totalPages)}
          disabled={page === totalPages}
          className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Última página"
        >
          »
        </button>
      </div>
    </div>
  )
}

// ── Widget ─────────────────────────────────────────────────────────────────────

export const CajaWidget = memo(function CajaWidget({ dateRange, platform, agent, revision, enabled = true }: {
  enabled?: boolean; dateRange: DateRange; platform: Platform; agent: string; revision: number
}) {
  const { from, to } = queryDateRange(dateRange)
  const [searchBy, setSearchBy] = useState<'username' | 'agente'>('username')
  const [search,   setSearch]   = useState('')
  const [inputVal, setInputVal] = useState('')
  const [page,     setPage]     = useState(1)

  const handleSearch = useCallback(() => {
    setSearch(inputVal)
    setPage(1)
  }, [inputVal])

  useEffect(() => { setPage(1) }, [from, to, platform, agent])
  const params: CajaParams = { enabled, from, to, platform, agent, revision, search, searchBy, page }
  const { rows, total, totals, loading, error } = useCajaData(params)

  const PER_PAGE = 20

  return (
    <Card>
      {/* ── Header ── */}
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Wallet className="w-4 h-4 text-primary" />
          Caja (Depósitos y Retiros)
        </CardTitle>

        <p className="text-xs text-muted-foreground">Período y plataforma del dashboard · {describeDateRange(dateRange)} · {PLATFORM_LABELS[platform]}{agent ? ` · ${agent}` : ''} · ARS. Saldo = depósitos + bonos registrados − retiros.</p>
        <div className="flex flex-wrap items-end gap-2 mt-2">
          {/* Search by selector + input */}
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Buscar en</span>
            <div className="flex gap-1">
              <Select
                value={searchBy}
                onValueChange={v => { setSearchBy(v as 'username' | 'agente'); setPage(1) }}
              >
                <SelectTrigger size="sm" className="h-7 w-[110px] text-xs">
                  <SelectValue>{searchBy === 'username' ? 'Jugadores' : 'Agentes'}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="username" className="text-xs">Jugadores</SelectItem>
                  <SelectItem value="agente"   className="text-xs">Agentes</SelectItem>
                </SelectContent>
              </Select>
              <div className="flex gap-1">
                <Input
                  placeholder={searchBy === 'username' ? 'username…' : 'agente…'}
                  value={inputVal}
                  onChange={e => setInputVal(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSearch()}
                  className="h-7 w-[120px] text-xs px-2"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2"
                  onClick={handleSearch}
                  aria-label="Buscar"
                >
                  <Search className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          </div>

        </div>
      </CardHeader>

      {/* ── Body ── */}
      <CardContent className="p-0">
        {loading ? (
          <div className="px-4 pb-4"><Skeleton /></div>
        ) : error ? (
          <p role="alert" className="p-4 text-sm text-destructive">{error}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground px-4 pb-4">
            Sin transacciones para el período seleccionado.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted">
                    {['Transacción', 'Fecha', 'Operación', 'Plataforma', 'Agente', 'Cuenta destino', 'Monto (ARS)', 'Detalles'].map(h => (
                      <th
                        key={h}
                        className="px-3 py-3 text-left font-semibold text-muted-foreground whitespace-nowrap"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => {
                    const isRetiro = row.tipo === 'retiro'
                    return (
                      <tr
                        key={row.id}
                        className="border-b border-border/50 hover:bg-muted/50 transition-colors"
                      >
                        <td className="px-3 py-2.5 tabular-nums text-muted-foreground">
                          {row.id_rec ?? row.id}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap tabular-nums">
                          {fmtDateTime(row)}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={cn(
                            'font-medium',
                            isRetiro ? 'text-rose-600' : 'text-emerald-600',
                          )}>
                            {isRetiro ? 'RETIRO' : row.tipo === 'bono' ? 'BONO' : 'DEPÓSITO'}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">{PLATFORM_LABELS[row.platform ?? ''] ?? 'Sin identificar'}</td>
                        <td className="px-3 py-2.5 font-medium capitalize">{row.agente}</td>
                        <td className="px-3 py-2.5 font-mono">{row.username}</td>
                        <td className={cn(
                          'px-3 py-2.5 text-right tabular-nums font-medium',
                          isRetiro ? 'text-rose-600' : 'text-foreground',
                        )}>
                          {isRetiro ? '-' : ''}{formatProviderPesos(row.monto, row.platform ?? '')}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <button
                            title={row.raw_detalles || '—'}
                            className="text-muted-foreground hover:text-foreground transition-colors"
                            aria-label="Ver detalles"
                          >
                            <BookOpen className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>

                {/* Totals row */}
                {totals && (
                  <tfoot>
                    <tr className="border-t-2 border-border bg-muted/60">
                      <td colSpan={4} className="px-3 py-3 font-semibold text-foreground">
                        TOTALES
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums" colSpan={2}>
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wide mr-2">Depósitos</span>
                        <span className="font-semibold text-emerald-600">{fmtMoney(totals.depositos)}</span>
                        <div className="text-xs text-muted-foreground">Bonos registrados: {fmtMoney(totals.deposito_bonificado ?? '0')}</div>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        <div className="flex flex-col items-end gap-0.5">
                          <div>
                            <span className="text-[10px] text-muted-foreground uppercase tracking-wide mr-1">Retiros</span>
                            <span className="font-semibold text-rose-600">{formatProviderPesos(totals.retiros, platform)}</span>
                          </div>
                          <div>
                            <span className="text-[10px] text-muted-foreground uppercase tracking-wide mr-1">Saldo con bonos</span>
                            <span className={cn(
                              'font-semibold',
                              !totals.saldo.startsWith('-') ? 'text-blue-600' : 'text-rose-600',
                            )}>
                              {formatProviderPesos(totals.saldo, platform)}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>

            <Pagination
              page={page}
              total={total}
              perPage={PER_PAGE}
              onChange={setPage}
            />
          </>
        )}
      </CardContent>
    </Card>
  )
})
