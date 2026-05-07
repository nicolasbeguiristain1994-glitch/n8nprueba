'use client'
import { Shield, ShieldAlert, Clock, Zap } from 'lucide-react'
import { Input } from '@/components/ui/input'
import {
  AntiBanValues, AntiBanPreset, ANTI_BAN_PRESETS,
  RANDOMNESS_CFG, DAYS_ES, DAYS_FULL_ES,
  type RandomnessLevel,
} from '@/lib/warmup-ui'

interface Props {
  value:    AntiBanValues
  onChange: (v: AntiBanValues) => void
}

// ── Preset card ─────────────────────────────────────────────────────────────────
function PresetCard({ preset, active, onApply }: {
  preset:  AntiBanPreset
  active:  boolean
  onApply: () => void
}) {
  const daysLabel = preset.config.activeDays.length === 7
    ? 'Todos los días'
    : preset.config.activeDays.length === 5
    ? 'Lun – Vie'
    : 'Lun – Sáb'

  return (
    <button
      type="button"
      onClick={onApply}
      className={`text-left rounded-xl border-2 px-3 py-2.5 transition-all ${
        active
          ? preset.badge.replace('bg-', 'border-').replace('-100', '-400') + ' ' + preset.badge
          : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
      }`}
    >
      <div className="flex items-center gap-1 mb-1">
        {preset.key === 'conservadora' && <Shield size={10} className="shrink-0" />}
        {preset.key === 'natural'      && <Clock  size={10} className="shrink-0" />}
        {preset.key === 'agresiva'     && <Zap    size={10} className="shrink-0" />}
        <span className="font-semibold text-xs">{preset.label}</span>
      </div>
      <p className="text-[10px] opacity-75 leading-tight">{preset.desc}</p>
      <p className="text-[10px] opacity-55 mt-1">
        {preset.config.delayMin}–{preset.config.delayMax}s · {preset.config.windowStart}–{preset.config.windowEnd} · {daysLabel}
      </p>
    </button>
  )
}

// ── Main component ──────────────────────────────────────────────────────────────
export function AntiBanConfig({ value, onChange }: Props) {
  const set = <K extends keyof AntiBanValues>(k: K, v: AntiBanValues[K]) =>
    onChange({ ...value, [k]: v })

  const applyPreset = (p: AntiBanPreset) =>
    onChange({ ...value, enabled: true, ...p.config })

  const activePreset = ANTI_BAN_PRESETS.find(p =>
    p.config.delayMin    === value.delayMin    &&
    p.config.delayMax    === value.delayMax    &&
    p.config.windowStart === value.windowStart &&
    p.config.windowEnd   === value.windowEnd   &&
    p.config.randomness  === value.randomness  &&
    p.config.naturalDist === value.naturalDist
  )

  const toggleDay = (day: number) => {
    const next = value.activeDays.includes(day)
      ? value.activeDays.filter(d => d !== day)
      : [...value.activeDays, day].sort((a, b) => a - b)
    if (next.length > 0) set('activeDays', next)
  }

  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden">

      {/* Header toggle */}
      <div className={`flex items-center justify-between px-4 py-3 ${value.enabled ? 'bg-blue-50 border-b border-blue-100' : 'bg-gray-50'}`}>
        <div className="flex items-center gap-2">
          <ShieldAlert size={15} className={value.enabled ? 'text-blue-600' : 'text-gray-400'} />
          <div>
            <p className={`text-xs font-semibold ${value.enabled ? 'text-blue-800' : 'text-gray-700'}`}>
              Modo Anti-Ban Avanzado
            </p>
            <p className="text-[10px] text-gray-500 leading-tight">
              Delays aleatorios, ventanas horarias y días activos
            </p>
          </div>
        </div>
        {/* Toggle switch */}
        <button
          type="button"
          onClick={() => set('enabled', !value.enabled)}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
            value.enabled ? 'bg-blue-600' : 'bg-gray-200'
          }`}
          aria-checked={value.enabled}
          role="switch"
        >
          <span
            className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-lg transition-transform ${
              value.enabled ? 'translate-x-4' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {/* Config body — shown only when enabled */}
      {value.enabled && (
        <div className="p-4 space-y-4 bg-white">

          {/* Preset cards */}
          <div>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">
              Estrategia anti-ban
            </p>
            <div className="grid grid-cols-3 gap-2">
              {ANTI_BAN_PRESETS.map(p => (
                <PresetCard
                  key={p.key}
                  preset={p}
                  active={activePreset?.key === p.key}
                  onApply={() => applyPreset(p)}
                />
              ))}
            </div>
          </div>

          {/* Delay range */}
          <div>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">
              Delay entre mensajes
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] text-gray-500 mb-1 block">Mínimo (segundos)</label>
                <Input
                  type="number" min={5} max={600}
                  value={value.delayMin}
                  title="Tiempo mínimo garantizado entre mensajes. El motor no enviará un mensaje si no transcurrieron al menos estos segundos."
                  onChange={e => {
                    const v = Math.max(5, parseInt(e.target.value) || 5)
                    set('delayMin', Math.min(v, value.delayMax - 5))
                  }}
                  className="text-sm h-8"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 mb-1 block">Máximo (segundos)</label>
                <Input
                  type="number" min={10} max={3600}
                  value={value.delayMax}
                  title="Límite superior del delay aleatorio. El delay real varía entre mínimo y máximo según el nivel de aleatoriedad configurado."
                  onChange={e => {
                    const v = Math.max(value.delayMin + 5, parseInt(e.target.value) || 60)
                    set('delayMax', v)
                  }}
                  className="text-sm h-8"
                />
              </div>
            </div>
            <p className="text-[10px] text-gray-400 mt-1.5">
              Con esta configuración enviarás aprox.{' '}
              <span className="font-semibold text-gray-600">
                {Math.round(3600 / ((value.delayMin + value.delayMax) / 2))} msgs/hora
              </span>
              {' '}(delay promedio ≈ {Math.round((value.delayMin + value.delayMax) / 2)}s)
            </p>
          </div>

          {/* Sending window */}
          <div>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">
              Ventana de envío
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] text-gray-500 mb-1 block">Inicio</label>
                <Input
                  type="time"
                  value={value.windowStart}
                  onChange={e => set('windowStart', e.target.value)}
                  className="text-sm h-8"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 mb-1 block">Fin</label>
                <Input
                  type="time"
                  value={value.windowEnd}
                  onChange={e => set('windowEnd', e.target.value)}
                  className="text-sm h-8"
                />
              </div>
            </div>
            {(() => {
              const [sh, sm] = value.windowStart.split(':').map(Number)
              const [eh, em] = value.windowEnd.split(':').map(Number)
              const hrs = Math.max(0, (eh * 60 + em - sh * 60 - sm) / 60)
              return (
                <p className="text-[10px] text-gray-400 mt-1.5">
                  Ventana activa: {hrs.toFixed(1)} horas · {value.windowStart} → {value.windowEnd}
                </p>
              )
            })()}
          </div>

          {/* Active days */}
          <div>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">
              Días activos
            </p>
            <div className="flex gap-1.5">
              {DAYS_ES.map((d, i) => {
                const dayNum  = i + 1
                const isOn    = value.activeDays.includes(dayNum)
                const fullDay = DAYS_FULL_ES[i]
                return (
                  <button
                    key={dayNum}
                    type="button"
                    title={fullDay}
                    onClick={() => toggleDay(dayNum)}
                    className={`w-8 h-8 rounded-lg text-xs font-semibold transition-colors ${
                      isOn
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
                    }`}
                  >
                    {d}
                  </button>
                )
              })}
            </div>
            <p className="text-[10px] text-gray-400 mt-1.5">
              {value.activeDays.length} día{value.activeDays.length !== 1 ? 's' : ''} activo{value.activeDays.length !== 1 ? 's' : ''}
            </p>
          </div>

          {/* Randomness level */}
          <div>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">
              Nivel de aleatoriedad
            </p>
            <div className="grid grid-cols-3 gap-2">
              {(Object.entries(RANDOMNESS_CFG) as [RandomnessLevel, { label: string; desc: string }][]).map(([key, cfg]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => set('randomness', key)}
                  className={`text-left rounded-lg border px-3 py-2 transition-all text-xs ${
                    value.randomness === key
                      ? 'border-blue-400 bg-blue-50 text-blue-800'
                      : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'
                  }`}
                >
                  <p className="font-semibold">{cfg.label}</p>
                  <p className="text-[10px] opacity-70 mt-0.5 leading-tight">{cfg.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Natural distribution toggle */}
          <div className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2.5">
            <div>
              <p className="text-xs font-medium text-gray-700">Distribución natural</p>
              <p className="text-[10px] text-gray-500 mt-0.5">Más actividad al mediodía, menos al inicio/fin del día</p>
            </div>
            <button
              type="button"
              onClick={() => set('naturalDist', !value.naturalDist)}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                value.naturalDist ? 'bg-blue-600' : 'bg-gray-200'
              }`}
              role="switch"
              aria-checked={value.naturalDist}
            >
              <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-lg transition-transform ${
                value.naturalDist ? 'translate-x-4' : 'translate-x-0'
              }`} />
            </button>
          </div>

        </div>
      )}
    </div>
  )
}
