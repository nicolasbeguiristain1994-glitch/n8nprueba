'use client'

import { useState, useRef } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Download, FileDown } from 'lucide-react'
import { downloadSingleVcf, downloadZippedVcf } from '@/lib/vcf-export'
import type { ExportableContact } from '@/lib/vcf-export'

// Matches the browsing page size in the contacts table
const BROWSE_PAGE_SIZE = 50

interface DownloadContactsModalProps {
  open: boolean
  onClose: () => void
  /** Conteo aproximado para mostrar en UI (no bloquea la descarga) */
  contactCount: number
  /** Parámetros de query para el endpoint de descarga (sin download=true) */
  fetchParams: URLSearchParams
  /** Parte del nombre de archivo. Ej: "todos", "lista-vip", "panel-betcoin" */
  filenameHint: string
  /** Endpoint al que se le agrega ?download=true. Default: /api/contacts */
  apiEndpoint?: string
}

export function DownloadContactsModal({
  open,
  onClose,
  contactCount,
  fetchParams,
  filenameHint,
  apiEndpoint = '/api/contacts',
}: DownloadContactsModalProps) {
  const [splitting, setSplitting]       = useState(false)
  const [batchSize, setBatchSize]       = useState(30)
  const [downloading, setDownloading]   = useState(false)
  const [error, setError]               = useState<string | null>(null)
  const [progress, setProgress]         = useState<{ loaded: number; total: number } | null>(null)
  const [rangeEnabled, setRangeEnabled] = useState(false)
  const [fromPage, setFromPage]         = useState(1)
  const [toPage, setToPage]             = useState(100)
  const cancelRef                       = useRef(false)

  const totalPages      = Math.max(1, Math.ceil(contactCount / BROWSE_PAGE_SIZE))
  const clampedFrom     = Math.min(Math.max(1, fromPage), totalPages)
  const clampedTo       = Math.min(Math.max(clampedFrom, toPage), totalPages)
  const rangeOffset     = (clampedFrom - 1) * BROWSE_PAGE_SIZE
  const rangeRowLimit   = Math.min(
    (clampedTo - clampedFrom + 1) * BROWSE_PAGE_SIZE,
    Math.max(0, contactCount - rangeOffset),
  )

  const effectiveCount  = rangeEnabled ? rangeRowLimit : contactCount
  const effectiveParts  = splitting && batchSize > 0 ? Math.ceil(effectiveCount / batchSize) : 1

  const handleDownload = async () => {
    setDownloading(true)
    setError(null)
    setProgress(null)
    cancelRef.current = false

    try {
      const baseParams = new URLSearchParams(fetchParams)
      baseParams.set('download', 'true')

      const rowLimit = rangeEnabled ? rangeRowLimit : null
      if (rangeEnabled) baseParams.set('from', String(rangeOffset))

      let allContacts: ExportableContact[] = []
      let currentPage = 1
      let serverTotal = 0

      do {
        if (cancelRef.current) throw new Error('Descarga cancelada')
        const params = new URLSearchParams(baseParams)
        params.set('page', String(currentPage))

        const res = await fetch(`${apiEndpoint}?${params}`)
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          throw new Error(d.error || `Error ${res.status}`)
        }

        const data = await res.json()
        const batch: ExportableContact[] = data.contacts ?? []
        serverTotal = data.total ?? batch.length

        const canAdd = rowLimit !== null ? rowLimit - allContacts.length : Infinity
        const toAdd  = batch.slice(0, canAdd)
        allContacts  = allContacts.concat(toAdd)

        const displayTotal = rowLimit !== null ? rowLimit : serverTotal
        setProgress({ loaded: allContacts.length, total: displayTotal })
        currentPage++

        if (batch.length === 0 || toAdd.length < batch.length) break
      } while (
        rowLimit !== null
          ? allContacts.length < rowLimit
          : allContacts.length < serverTotal
      )

      if (allContacts.length === 0) {
        throw new Error('No hay contactos para descargar')
      }

      const date     = new Date().toISOString().slice(0, 10)
      const basename = `contactos_${filenameHint}_${date}`

      if (splitting) {
        await downloadZippedVcf(allContacts, batchSize, basename)
      } else {
        downloadSingleVcf(allContacts, `${basename}.vcf`)
      }

      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error inesperado al descargar')
    } finally {
      setDownloading(false)
      setProgress(null)
    }
  }

  const handleClose = () => {
    if (downloading) {
      cancelRef.current = true
      return
    }
    setError(null)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) handleClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileDown size={16} /> Descargar contactos
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Formato */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-2 block">Formato</label>
            <div className="flex items-center gap-2 bg-teal-50 border border-teal-200 rounded-lg px-3 py-2.5">
              <span className="font-bold text-xs text-teal-700 bg-teal-100 px-1.5 py-0.5 rounded">VCF</span>
              <span className="text-sm text-teal-800 font-medium">vCard 3.0</span>
              <span className="ml-auto text-xs text-teal-500 italic">Recomendado</span>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1.5">
              Compatible con Gmail, iPhone, Android y Outlook.
            </p>
          </div>

          {/* Toggle rango de páginas */}
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setRangeEnabled(v => !v)}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg border transition-colors text-sm ${
                rangeEnabled
                  ? 'bg-orange-50 border-orange-300 text-orange-800'
                  : 'bg-background border-border text-foreground hover:bg-muted'
              }`}
            >
              <span className="font-medium">Seleccionar rango de páginas</span>
              <span className={`relative inline-flex w-9 h-5 rounded-full transition-colors flex-shrink-0 ${
                rangeEnabled ? 'bg-orange-500' : 'bg-muted-foreground/30'
              }`}>
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
                  rangeEnabled ? 'translate-x-4' : 'translate-x-0.5'
                }`} />
              </span>
            </button>

            {rangeEnabled && (
              <div className="space-y-2 pl-1">
                <div className="flex items-center gap-2">
                  <label className="text-sm text-muted-foreground w-28 whitespace-nowrap">Desde página</label>
                  <Input
                    type="number"
                    min={1}
                    max={totalPages}
                    value={fromPage}
                    onChange={e => {
                      const v = Math.max(1, parseInt(e.target.value, 10) || 1)
                      setFromPage(v)
                      if (toPage < v) setToPage(v)
                    }}
                    className="w-24 text-center"
                  />
                  <span className="text-xs text-muted-foreground whitespace-nowrap">de {totalPages.toLocaleString('es-AR')}</span>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-muted-foreground w-28 whitespace-nowrap">Hasta página</label>
                  <Input
                    type="number"
                    min={fromPage}
                    max={totalPages}
                    value={toPage}
                    onChange={e => setToPage(Math.max(fromPage, Math.min(totalPages, parseInt(e.target.value, 10) || fromPage)))}
                    className="w-24 text-center"
                  />
                </div>
                {rangeRowLimit > 0 && (
                  <p className="text-xs text-muted-foreground">
                    ~<span className="font-semibold text-orange-700">{rangeRowLimit.toLocaleString('es-AR')}</span>{' '}
                    contactos (pág. {clampedFrom.toLocaleString('es-AR')}–{clampedTo.toLocaleString('es-AR')})
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Toggle dividir en varios archivos */}
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setSplitting(v => !v)}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg border transition-colors text-sm ${
                splitting
                  ? 'bg-indigo-50 border-indigo-300 text-indigo-800'
                  : 'bg-background border-border text-foreground hover:bg-muted'
              }`}
            >
              <span className="font-medium">Dividir en varios archivos</span>
              <span className={`relative inline-flex w-9 h-5 rounded-full transition-colors flex-shrink-0 ${
                splitting ? 'bg-indigo-500' : 'bg-muted-foreground/30'
              }`}>
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
                  splitting ? 'translate-x-4' : 'translate-x-0.5'
                }`} />
              </span>
            </button>

            {splitting && (
              <div className="flex items-center gap-3 pl-1">
                <label className="text-sm text-muted-foreground whitespace-nowrap">
                  Contactos por archivo
                </label>
                <Input
                  type="number"
                  min={1}
                  max={10000}
                  value={batchSize}
                  onChange={e => setBatchSize(Math.max(1, parseInt(e.target.value, 10) || 1))}
                  className="w-24 text-center"
                />
              </div>
            )}

            {splitting && effectiveCount > 0 && (
              <p className="text-xs text-muted-foreground pl-1">
                ~{effectiveCount.toLocaleString('es-AR')} contactos →{' '}
                <span className="font-semibold text-indigo-700">
                  {effectiveParts} archivo{effectiveParts !== 1 ? 's' : ''} VCF
                </span>{' '}
                dentro de un ZIP
              </p>
            )}
          </div>

          {/* Resumen */}
          <div className="bg-muted/50 rounded-lg px-3 py-2.5 text-xs text-muted-foreground">
            Se descargarán aprox.{' '}
            <span className="font-semibold text-foreground">
              {effectiveCount.toLocaleString('es-AR')}
            </span>{' '}
            contactos
            {splitting
              ? ` en ${effectiveParts} archivo${effectiveParts !== 1 ? 's' : ''} comprimidos (ZIP)`
              : ' en un único archivo VCF'
            }
          </div>

          {/* Progreso de descarga */}
          {downloading && progress && (
            <div className="space-y-1.5">
              <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                <div
                  className="bg-teal-500 h-1.5 rounded-full transition-all duration-300"
                  style={{ width: `${Math.min(100, (progress.loaded / progress.total) * 100)}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground text-center tabular-nums">
                Cargando {progress.loaded.toLocaleString('es-AR')} / {progress.total.toLocaleString('es-AR')} contactos…
              </p>
            </div>
          )}

          {error && (
            <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={handleClose}
            >
              Cancelar
            </Button>
            <Button
              className="flex-1 bg-teal-600 hover:bg-teal-700 text-white"
              onClick={handleDownload}
              disabled={downloading || (rangeEnabled && rangeRowLimit === 0)}
            >
              <Download size={14} className={`mr-1.5 ${downloading ? 'animate-bounce' : ''}`} />
              {downloading ? 'Descargando…' : 'Descargar'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
