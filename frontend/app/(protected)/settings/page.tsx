'use client'
import { useEffect, useState } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Loader2, CheckCircle2, AlertCircle, Settings } from 'lucide-react'
import { useCurrentUser } from '@/lib/useCurrentUser'

type AppSettings = {
  general_timezone: string
  general_date_format: string
  general_rows_per_page: number
  general_env_name: string
  contacts_export_format: string
  contacts_max_bulk_select: number
  contacts_phone_normalize: boolean
  casino_enabled_agents: string[]
  casino_default_agent: string
  casino_default_time_mode: string
  casino_risk_inactive_min: number
  casino_risk_inactive_max: number
  limits_max_lines: number
  limits_max_warmup_lines: number
  perms_contacts_export_global: boolean
  perms_zeus_sync_global: boolean
}

const ALL_AGENTS = ['betcoin', 'bigwin', 'farabet', 'ofizeus', 'royal']

const TIMEZONES = [
  'America/Argentina/Buenos_Aires',
  'America/Sao_Paulo',
  'America/Santiago',
  'America/Montevideo',
  'America/Bogota',
  'America/Lima',
  'UTC',
]

const DATE_FORMATS = [
  { value: 'DD/MM/YYYY HH:mm', label: 'DD/MM/AAAA HH:mm (24h)' },
  { value: 'MM/DD/YYYY hh:mm a', label: 'MM/DD/AAAA hh:mm AM/PM' },
  { value: 'YYYY-MM-DD HH:mm', label: 'AAAA-MM-DD HH:mm (ISO)' },
]

export default function SettingsPage() {
  const { user } = useCurrentUser()
  const isAdmin = user?.role === 'admin'

  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  // Per-section save state
  const [saving, setSaving] = useState<string | null>(null)  // section name
  const [saved, setSaved]   = useState<string | null>(null)  // section name
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then((d: { settings: AppSettings }) => { setSettings(d.settings); setLoading(false) })
      .catch(() => { setFetchError('Error al cargar la configuración'); setLoading(false) })
  }, [])

  const handleSave = async (section: string, partial: Partial<AppSettings>) => {
    setSaving(section)
    setSaved(null)
    setSaveError(null)
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string }
        setSaveError(d.error || `Error ${res.status}`)
        return
      }
      setSettings(prev => prev ? { ...prev, ...partial } : prev)
      setSaved(section)
      setTimeout(() => setSaved(null), 3000)
    } catch {
      setSaveError('Error de red al guardar')
    } finally {
      setSaving(null)
    }
  }

  if (loading) return (
    <div className="flex items-center justify-center h-48">
      <Loader2 size={24} className="animate-spin text-gray-400" />
    </div>
  )

  if (!settings || fetchError) return (
    <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3 max-w-lg">
      <AlertCircle size={16} className="shrink-0" />
      {fetchError || 'Error al cargar la configuración'}
    </div>
  )

  const disabled = !isAdmin

  function SaveRow({ section }: { section: string }) {
    const isSaving = saving === section
    const wasSaved  = saved  === section
    return (
      <div className="flex items-center gap-3 pt-4 border-t border-gray-100 mt-4">
        {!disabled && (
          <Button
            onClick={() => {
              if (section === 'general') handleSave('general', {
                general_timezone:    settings!.general_timezone,
                general_date_format: settings!.general_date_format,
                general_rows_per_page: settings!.general_rows_per_page,
                general_env_name:    settings!.general_env_name,
              })
              else if (section === 'contacts') handleSave('contacts', {
                contacts_export_format:   settings!.contacts_export_format,
                contacts_max_bulk_select: settings!.contacts_max_bulk_select,
                contacts_phone_normalize: settings!.contacts_phone_normalize,
              })
              else if (section === 'casino') handleSave('casino', {
                casino_enabled_agents:    settings!.casino_enabled_agents,
                casino_default_agent:     settings!.casino_default_agent,
                casino_default_time_mode: settings!.casino_default_time_mode,
                casino_risk_inactive_min: settings!.casino_risk_inactive_min,
                casino_risk_inactive_max: settings!.casino_risk_inactive_max,
              })
              else if (section === 'limits') handleSave('limits', {
                limits_max_lines:        settings!.limits_max_lines,
                limits_max_warmup_lines: settings!.limits_max_warmup_lines,
              })
              else if (section === 'perms') handleSave('perms', {
                perms_contacts_export_global: settings!.perms_contacts_export_global,
                perms_zeus_sync_global:       settings!.perms_zeus_sync_global,
              })
            }}
            disabled={isSaving}
            className="h-8 text-sm"
          >
            {isSaving ? <><Loader2 size={13} className="animate-spin mr-1" />Guardando…</> : 'Guardar'}
          </Button>
        )}
        {wasSaved && (
          <span className="flex items-center gap-1 text-sm text-green-600">
            <CheckCircle2 size={14} /> Guardado correctamente
          </span>
        )}
        {saveError && saving === null && saved === null && (
          <span className="flex items-center gap-1 text-sm text-red-600">
            <AlertCircle size={14} /> {saveError}
          </span>
        )}
        {disabled && (
          <span className="text-xs text-gray-400">Solo los administradores pueden modificar estos valores.</span>
        )}
      </div>
    )
  }

  function FieldRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    return (
      <div className="grid grid-cols-3 gap-4 items-start py-3 border-b border-gray-50 last:border-0">
        <div>
          <p className="text-sm font-medium text-gray-700">{label}</p>
          {hint && <p className="text-xs text-gray-400 mt-0.5">{hint}</p>}
        </div>
        <div className="col-span-2">{children}</div>
      </div>
    )
  }

  return (
    <div className="max-w-3xl space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 bg-gray-100 rounded-lg flex items-center justify-center">
          <Settings size={16} className="text-gray-600" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Ajustes</h1>
          <p className="text-sm text-gray-500">Configuración global del sistema</p>
        </div>
      </div>

      {saveError && saving === null && (
        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
          <AlertCircle size={16} className="shrink-0" />
          {saveError}
        </div>
      )}

      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="contacts">Contactos</TabsTrigger>
          <TabsTrigger value="casino">Casino</TabsTrigger>
          <TabsTrigger value="limits">Límites</TabsTrigger>
          <TabsTrigger value="perms">Permisos</TabsTrigger>
        </TabsList>

        {/* ── General ─────────────────────────────────────────────────── */}
        <TabsContent value="general">
          <Card className="mt-4">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">General</CardTitle>
            </CardHeader>
            <CardContent>
              <FieldRow label="Nombre del entorno" hint="Aparece en la barra lateral">
                <Input
                  value={settings.general_env_name}
                  disabled={disabled}
                  onChange={e => setSettings(s => s ? { ...s, general_env_name: e.target.value } : s)}
                  className="h-8 text-sm max-w-xs"
                />
              </FieldRow>
              <FieldRow label="Zona horaria" hint="Referencia para fechas en reportes">
                <Select
                  value={settings.general_timezone}
                  disabled={disabled}
                  onValueChange={v => setSettings(s => s ? { ...s, general_timezone: v ?? s.general_timezone } : s)}
                >
                  <SelectTrigger className="h-8 text-sm max-w-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIMEZONES.map(tz => (
                      <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Formato de fecha/hora">
                <Select
                  value={settings.general_date_format}
                  disabled={disabled}
                  onValueChange={v => setSettings(s => s ? { ...s, general_date_format: v ?? s.general_date_format } : s)}
                >
                  <SelectTrigger className="h-8 text-sm max-w-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DATE_FORMATS.map(f => (
                      <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Filas por página" hint="En tablas con paginación">
                <Input
                  type="number"
                  min={10}
                  max={200}
                  value={settings.general_rows_per_page}
                  disabled={disabled}
                  onChange={e => setSettings(s => s ? { ...s, general_rows_per_page: Number(e.target.value) } : s)}
                  className="h-8 text-sm w-24"
                />
              </FieldRow>
              <SaveRow section="general" />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Contactos ───────────────────────────────────────────────── */}
        <TabsContent value="contacts">
          <Card className="mt-4">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Contactos</CardTitle>
            </CardHeader>
            <CardContent>
              <FieldRow label="Formato de exportación" hint="CSV, Excel o VCF">
                <Select
                  value={settings.contacts_export_format}
                  disabled={disabled}
                  onValueChange={v => setSettings(s => s ? { ...s, contacts_export_format: v ?? s.contacts_export_format } : s)}
                >
                  <SelectTrigger className="h-8 text-sm max-w-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="csv">CSV</SelectItem>
                    <SelectItem value="excel">Excel (.xlsx)</SelectItem>
                    <SelectItem value="vcf">VCF (vCard)</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Límite de selección masiva" hint="Máximo de contactos seleccionables a la vez">
                <Input
                  type="number"
                  min={100}
                  max={100000}
                  value={settings.contacts_max_bulk_select}
                  disabled={disabled}
                  onChange={e => setSettings(s => s ? { ...s, contacts_max_bulk_select: Number(e.target.value) } : s)}
                  className="h-8 text-sm w-28"
                />
              </FieldRow>
              <FieldRow label="Normalizar teléfonos" hint="Aplica al importar contactos">
                <label className={`flex items-center gap-2 cursor-pointer ${disabled ? 'opacity-50' : ''}`}>
                  <input
                    type="checkbox"
                    className="w-4 h-4 accent-green-600"
                    checked={settings.contacts_phone_normalize}
                    disabled={disabled}
                    onChange={e => setSettings(s => s ? { ...s, contacts_phone_normalize: e.target.checked } : s)}
                  />
                  <span className="text-sm text-gray-700">Activado</span>
                </label>
              </FieldRow>
              <SaveRow section="contacts" />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Casino ──────────────────────────────────────────────────── */}
        <TabsContent value="casino">
          <Card className="mt-4">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Casino / Agentes</CardTitle>
            </CardHeader>
            <CardContent>
              <FieldRow label="Agentes habilitados" hint="Aparecen en el dashboard casino">
                <div className="flex flex-wrap gap-3">
                  {ALL_AGENTS.map(ag => (
                    <label key={ag} className={`flex items-center gap-2 cursor-pointer ${disabled ? 'opacity-50' : ''}`}>
                      <input
                        type="checkbox"
                        className="w-4 h-4 accent-green-600"
                        checked={settings.casino_enabled_agents.includes(ag)}
                        disabled={disabled}
                        onChange={e => {
                          const next = e.target.checked
                            ? [...settings.casino_enabled_agents, ag]
                            : settings.casino_enabled_agents.filter(a => a !== ag)
                          setSettings(s => s ? { ...s, casino_enabled_agents: next } : s)
                        }}
                      />
                      <span className="text-sm text-gray-700 capitalize">{ag}</span>
                    </label>
                  ))}
                </div>
              </FieldRow>
              <FieldRow label="Agente por defecto" hint="Filtro inicial al abrir el dashboard">
                <Select
                  value={settings.casino_default_agent}
                  disabled={disabled}
                  onValueChange={v => setSettings(s => s ? { ...s, casino_default_agent: v ?? s.casino_default_agent } : s)}
                >
                  <SelectTrigger className="h-8 text-sm max-w-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">Todos</SelectItem>
                    {ALL_AGENTS.map(ag => (
                      <SelectItem key={ag} value={ag} className="capitalize">{ag}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Modo horario por defecto" hint="Referencia de hora en búsquedas">
                <Select
                  value={settings.casino_default_time_mode}
                  disabled={disabled}
                  onValueChange={v => setSettings(s => s ? { ...s, casino_default_time_mode: v ?? s.casino_default_time_mode } : s)}
                >
                  <SelectTrigger className="h-8 text-sm max-w-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="local">Local</SelectItem>
                    <SelectItem value="utc">UTC</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Días inactivo (mín)" hint="Umbral mínimo para riesgo">
                <Input
                  type="number"
                  min={1}
                  max={365}
                  value={settings.casino_risk_inactive_min}
                  disabled={disabled}
                  onChange={e => setSettings(s => s ? { ...s, casino_risk_inactive_min: Number(e.target.value) } : s)}
                  className="h-8 text-sm w-24"
                />
              </FieldRow>
              <FieldRow label="Días inactivo (máx)" hint="Umbral máximo para riesgo">
                <Input
                  type="number"
                  min={1}
                  max={365}
                  value={settings.casino_risk_inactive_max}
                  disabled={disabled}
                  onChange={e => setSettings(s => s ? { ...s, casino_risk_inactive_max: Number(e.target.value) } : s)}
                  className="h-8 text-sm w-24"
                />
              </FieldRow>
              <SaveRow section="casino" />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Límites ─────────────────────────────────────────────────── */}
        <TabsContent value="limits">
          <Card className="mt-4">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Límites operativos</CardTitle>
            </CardHeader>
            <CardContent>
              <FieldRow label="Máx. líneas WhatsApp" hint="Límite total de líneas en el pool">
                <Input
                  type="number"
                  min={1}
                  max={500}
                  value={settings.limits_max_lines}
                  disabled={disabled}
                  onChange={e => setSettings(s => s ? { ...s, limits_max_lines: Number(e.target.value) } : s)}
                  className="h-8 text-sm w-24"
                />
              </FieldRow>
              <FieldRow label="Máx. líneas calentamiento" hint="Límite de números en warmup simultáneo">
                <Input
                  type="number"
                  min={1}
                  max={200}
                  value={settings.limits_max_warmup_lines}
                  disabled={disabled}
                  onChange={e => setSettings(s => s ? { ...s, limits_max_warmup_lines: Number(e.target.value) } : s)}
                  className="h-8 text-sm w-24"
                />
              </FieldRow>
              <SaveRow section="limits" />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Permisos ─────────────────────────────────────────────────── */}
        <TabsContent value="perms">
          <Card className="mt-4">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Permisos funcionales globales</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-gray-400 mb-4">
                Estos toggles controlan funciones a nivel del sistema. Un toggle desactivado bloquea la función para todos los usuarios, independientemente de sus permisos individuales.
              </p>
              <FieldRow label="Descarga de contactos" hint="Habilita o bloquea la descarga global">
                <label className={`flex items-center gap-2 cursor-pointer ${disabled ? 'opacity-50' : ''}`}>
                  <input
                    type="checkbox"
                    className="w-4 h-4 accent-green-600"
                    checked={settings.perms_contacts_export_global}
                    disabled={disabled}
                    onChange={e => setSettings(s => s ? { ...s, perms_contacts_export_global: e.target.checked } : s)}
                  />
                  <span className="text-sm text-gray-700">
                    {settings.perms_contacts_export_global ? 'Habilitada' : 'Deshabilitada'}
                  </span>
                </label>
              </FieldRow>
              <FieldRow label="Sincronización Zeus" hint="Permite disparar sincronizaciones manuales">
                <label className={`flex items-center gap-2 cursor-pointer ${disabled ? 'opacity-50' : ''}`}>
                  <input
                    type="checkbox"
                    className="w-4 h-4 accent-green-600"
                    checked={settings.perms_zeus_sync_global}
                    disabled={disabled}
                    onChange={e => setSettings(s => s ? { ...s, perms_zeus_sync_global: e.target.checked } : s)}
                  />
                  <span className="text-sm text-gray-700">
                    {settings.perms_zeus_sync_global ? 'Habilitada' : 'Deshabilitada'}
                  </span>
                </label>
              </FieldRow>
              <SaveRow section="perms" />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
