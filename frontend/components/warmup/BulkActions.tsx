'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Loader2, Pause, Play, RotateCcw, Download, X, ChevronDown } from 'lucide-react'
import type { DelayPreset } from '@/lib/warmup-engine'
import { PRESET_LABEL } from '@/lib/warmup-ui'

interface BulkRow {
  id:            string
  display_name:  string | null
  instance_name: string
  warmup_status: string
}

interface Props {
  selected:   Set<string>
  numbers:    BulkRow[]
  onClear:    () => void
  onPause:    (ids: string[]) => Promise<void>
  onResume:   (ids: string[]) => Promise<void>
  onReset:    (ids: string[]) => Promise<void>
  onStrategy: (ids: string[], preset: DelayPreset) => Promise<void>
  onExport:   (ids: string[]) => void
}

const PRESETS: DelayPreset[] = ['conservadora', 'normal', 'agresiva']

export function BulkActions({
  selected, numbers, onClear,
  onPause, onResume, onReset, onStrategy, onExport,
}: Props) {
  const [busy,         setBusy]         = useState<string | null>(null)
  const [showStrategy, setShowStrategy] = useState(false)

  if (selected.size === 0) return null

  const ids          = Array.from(selected)
  const selectedRows = numbers.filter(n => selected.has(n.id))
  const canPause     = selectedRows.some(n => n.warmup_status === 'active')
  const canResume    = selectedRows.some(n => n.warmup_status === 'paused')

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); await fn(); setBusy(null)
  }

  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1.5 bg-gray-900 text-white px-4 py-2.5 rounded-full shadow-2xl border border-gray-700 text-sm">

      <span className="font-semibold text-amber-400 mr-1.5 text-xs">
        {selected.size} seleccionada{selected.size !== 1 ? 's' : ''}
      </span>

      {canPause && (
        <Button size="sm" variant="ghost"
          className="h-7 px-3 text-xs text-white hover:bg-card/10 rounded-full"
          disabled={busy !== null}
          onClick={() => run('pause', () => onPause(ids))}
        >
          {busy === 'pause'
            ? <Loader2 size={11} className="animate-spin mr-1" />
            : <Pause size={11} className="mr-1" />}
          Pausar
        </Button>
      )}

      {canResume && (
        <Button size="sm" variant="ghost"
          className="h-7 px-3 text-xs text-white hover:bg-card/10 rounded-full"
          disabled={busy !== null}
          onClick={() => run('resume', () => onResume(ids))}
        >
          {busy === 'resume'
            ? <Loader2 size={11} className="animate-spin mr-1" />
            : <Play size={11} className="mr-1" />}
          Reanudar
        </Button>
      )}

      {/* Strategy picker */}
      <div className="relative">
        <Button size="sm" variant="ghost"
          className="h-7 px-3 text-xs text-white hover:bg-card/10 rounded-full"
          onClick={() => setShowStrategy(v => !v)}
        >
          Estrategia <ChevronDown size={10} className="ml-1" />
        </Button>
        {showStrategy && (
          <div className="absolute bottom-10 left-1/2 -translate-x-1/2 bg-card rounded-xl shadow-xl border border-border py-1.5 min-w-[148px] z-50">
            {PRESETS.map(p => (
              <button key={p}
                className="w-full text-left px-3.5 py-1.5 text-xs text-foreground hover:bg-background transition-colors"
                onClick={() => { setShowStrategy(false); run('strategy', () => onStrategy(ids, p)) }}
              >
                {PRESET_LABEL[p]}
              </button>
            ))}
          </div>
        )}
      </div>

      <Button size="sm" variant="ghost"
        className="h-7 px-3 text-xs text-white hover:bg-card/10 rounded-full"
        disabled={busy !== null}
        onClick={() => run('reset', () => onReset(ids))}
      >
        {busy === 'reset'
          ? <Loader2 size={11} className="animate-spin mr-1" />
          : <RotateCcw size={11} className="mr-1" />}
        Reiniciar
      </Button>

      <div className="w-px h-4 bg-gray-600 mx-0.5" />

      <Button size="sm" variant="ghost"
        className="h-7 px-3 text-xs text-white hover:bg-card/10 rounded-full"
        onClick={() => onExport(ids)}
      >
        <Download size={11} className="mr-1" /> CSV
      </Button>

      <button
        className="ml-1 text-muted-foreground hover:text-white p-1 rounded-full transition-colors"
        onClick={onClear}
      >
        <X size={13} />
      </button>
    </div>
  )
}
