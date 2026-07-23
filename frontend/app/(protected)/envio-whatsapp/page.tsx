'use client'
import { useState, useRef, useCallback, useEffect } from 'react'
import * as XLSX from 'xlsx'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Upload, MessageSquareText, ExternalLink, Trash2, CheckCircle2, Plus, Pencil, Check, X } from 'lucide-react'
import { normalizePhone } from '@/lib/validate'
import { PageHeader } from '@/components/layout/PageHeader'

// ─── tipos ───────────────────────────────────────────────────────────────────

interface Recipient {
  phone: string
  name?: string
  sent?: boolean
}

interface Template {
  id: string
  name: string
  body: string
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'wa_envio_templates'

const DEFAULT_TEMPLATES: Template[] = [
  { id: 'default', name: 'Mensaje base', body: 'Hola {nombre}! Te escribo desde...' },
]

function loadTemplates(): Template[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_TEMPLATES
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_TEMPLATES
  } catch {
    return DEFAULT_TEMPLATES
  }
}

function saveTemplates(templates: Template[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(templates)) } catch {}
}

function uid() {
  return Math.random().toString(36).slice(2, 10)
}

function parseVcfText(text: string): Recipient[] {
  const cards = text.split('BEGIN:VCARD')
  const rows: Recipient[] = []
  const seen = new Set<string>()
  for (const card of cards) {
    const fnMatch  = card.match(/^FN:(.+)$/m)
    const telLines = [...card.matchAll(/^TEL[^:]*:(.+)$/gm)]
    if (!fnMatch) continue
    const name = fnMatch[1].trim()
    let phone: string | null = null
    for (const tel of telLines) {
      const n = normalizePhone(tel[1].trim())
      if (n) { phone = n; break }
    }
    if (!phone || seen.has(phone)) continue
    seen.add(phone)
    rows.push({ phone, name })
  }
  return rows
}

// ─── componente ──────────────────────────────────────────────────────────────

export default function EnvioWhatsappPage() {
  const [templates, setTemplates]       = useState<Template[]>(DEFAULT_TEMPLATES)
  const [activeId, setActiveId]         = useState<string>('default')
  const [editingId, setEditingId]       = useState<string | null>(null)
  const [editName, setEditName]         = useState('')
  const [editBody, setEditBody]         = useState('')
  const [addingNew, setAddingNew]       = useState(false)
  const [newName, setNewName]           = useState('')
  const [newBody, setNewBody]           = useState('')

  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [fileName, setFileName]     = useState('')
  const [error, setError]           = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Cargar plantillas de localStorage al montar
  useEffect(() => {
    const loaded = loadTemplates()
    setTemplates(loaded)
    setActiveId(loaded[0]?.id ?? 'default')
  }, [])

  const activeTemplate = templates.find(t => t.id === activeId) ?? templates[0]
  const activeBody = activeTemplate?.body ?? ''

  // ── CRUD plantillas ────────────────────────────────────────────────────────

  const startEdit = (t: Template) => {
    setEditingId(t.id)
    setEditName(t.name)
    setEditBody(t.body)
  }

  const saveEdit = () => {
    if (!editName.trim() || !editBody.trim()) return
    const updated = templates.map(t =>
      t.id === editingId ? { ...t, name: editName.trim(), body: editBody.trim() } : t
    )
    setTemplates(updated)
    saveTemplates(updated)
    setEditingId(null)
  }

  const cancelEdit = () => setEditingId(null)

  const deleteTemplate = (id: string) => {
    if (templates.length <= 1) return // siempre dejar al menos 1
    const updated = templates.filter(t => t.id !== id)
    setTemplates(updated)
    saveTemplates(updated)
    if (activeId === id) setActiveId(updated[0].id)
  }

  const confirmNew = () => {
    if (!newName.trim() || !newBody.trim()) return
    const t: Template = { id: uid(), name: newName.trim(), body: newBody.trim() }
    const updated = [...templates, t]
    setTemplates(updated)
    saveTemplates(updated)
    setActiveId(t.id)
    setAddingNew(false)
    setNewName('')
    setNewBody('')
  }

  const cancelNew = () => {
    setAddingNew(false)
    setNewName('')
    setNewBody('')
  }

  // ── archivo ────────────────────────────────────────────────────────────────

  const handleFile = useCallback((file: File) => {
    setError('')
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = (e) => {
      const data = e.target?.result
      let rows: Recipient[] = []
      try {
        if (file.name.toLowerCase().endsWith('.vcf')) {
          rows = parseVcfText(data as string)
        } else if (file.name.toLowerCase().endsWith('.csv')) {
          const text = data as string
          const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
          const header = lines[0].toLowerCase().split(',').map(h => h.trim().replace(/"/g, ''))
          const phoneIdx = header.findIndex(h => h.includes('phone') || h.includes('tel') || h.includes('celular') || h.includes('numero'))
          const nameIdx  = header.findIndex(h => h.includes('name') || h.includes('nombre'))
          rows = lines.slice(1).map(l => {
            const cols = l.split(',').map(c => c.trim().replace(/"/g, ''))
            const norm = normalizePhone(cols[phoneIdx] || '')
            return (norm ? { phone: norm, name: cols[nameIdx] || undefined } : null) as Recipient | null
          }).filter((r): r is Recipient => !!r)
        } else {
          const wb = XLSX.read(data, { type: 'binary' })
          const ws = wb.Sheets[wb.SheetNames[0]]
          const json = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: '' })
          rows = json.map(row => {
            const phoneKey = Object.keys(row).find(k => k.toLowerCase().includes('phone') || k.toLowerCase().includes('tel') || k.toLowerCase().includes('celular') || k.toLowerCase().includes('numero')) || ''
            const nameKey  = Object.keys(row).find(k => k.toLowerCase().includes('name') || k.toLowerCase().includes('nombre')) || ''
            const norm = normalizePhone(String(row[phoneKey] || ''))
            return (norm ? { phone: norm, name: row[nameKey] || undefined } : null) as Recipient | null
          }).filter((r): r is Recipient => !!r)
        }
        const seen = new Set<string>()
        rows = rows.filter(r => (seen.has(r.phone) ? false : (seen.add(r.phone), true)))
        if (rows.length === 0) setError('No se encontraron números válidos en el archivo.')
        setRecipients(rows)
      } catch {
        setError('No se pudo leer el archivo. Verificá que sea un CSV o VCF válido.')
      }
    }
    if (file.name.toLowerCase().endsWith('.vcf') || file.name.toLowerCase().endsWith('.csv')) {
      reader.readAsText(file)
    } else {
      reader.readAsBinaryString(file)
    }
  }, [])

  const buildText = useCallback((r: Recipient) => {
    return activeBody
      .replaceAll('{nombre}', r.name || '')
      .replaceAll('{telefono}', r.phone)
  }, [activeBody])

  const openChat = useCallback((r: Recipient, idx: number) => {
    const text = encodeURIComponent(buildText(r))
    const phoneDigits = r.phone.replace(/\D/g, '')
    window.open(`https://wa.me/${phoneDigits}?text=${text}`, '_blank')
    setRecipients(prev => prev.map((x, i) => i === idx ? { ...x, sent: true } : x))
  }, [buildText])

  const clearAll = useCallback(() => {
    setRecipients([])
    setFileName('')
    setError('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [])

  const sentCount = recipients.filter(r => r.sent).length

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      <PageHeader
        title="Envío por WhatsApp"
        description="Subí contactos (CSV o VCF), elegí un mensaje y abrí cada chat con el texto pre-armado. El envío final lo confirmás vos en WhatsApp."
      />

      {/* ── Plantillas ── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs text-muted-foreground">Plantillas de mensaje</label>
          <Button variant="ghost" size="sm" className="text-xs h-7 px-2" onClick={() => setAddingNew(true)}>
            <Plus size={13} className="mr-1" /> Nueva plantilla
          </Button>
        </div>

        <div className="border rounded-lg divide-y">
          {templates.map(t => (
            <div key={t.id} className={`p-3 transition-colors ${activeId === t.id ? 'bg-violet-50/60 dark:bg-violet-950/20' : ''}`}>
              {editingId === t.id ? (
                /* ── modo edición ── */
                <div className="space-y-2">
                  <Input
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    placeholder="Nombre de la plantilla"
                    className="h-8 text-sm"
                  />
                  <Textarea
                    value={editBody}
                    onChange={e => setEditBody(e.target.value)}
                    rows={3}
                    className="resize-y text-sm"
                    placeholder="Texto del mensaje. Usá {nombre} y {telefono}."
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={saveEdit} className="h-7 px-3 text-xs">
                      <Check size={12} className="mr-1" /> Guardar
                    </Button>
                    <Button size="sm" variant="ghost" onClick={cancelEdit} className="h-7 px-3 text-xs">
                      <X size={12} className="mr-1" /> Cancelar
                    </Button>
                  </div>
                </div>
              ) : (
                /* ── modo vista ── */
                <div className="flex items-start gap-2">
                  <button
                    onClick={() => setActiveId(t.id)}
                    className="flex-1 text-left group"
                  >
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${activeId === t.id ? 'bg-violet-500' : 'bg-zinc-300'}`} />
                      <span className={`text-sm font-medium ${activeId === t.id ? 'text-violet-700 dark:text-violet-300' : ''}`}>
                        {t.name}
                      </span>
                      {activeId === t.id && (
                        <span className="text-xs text-violet-500 font-normal">activa</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 ml-4 line-clamp-2">{t.body}</p>
                  </button>
                  <div className="flex gap-1 flex-shrink-0">
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => startEdit(t)}>
                      <Pencil size={12} />
                    </Button>
                    <Button
                      variant="ghost" size="sm"
                      className="h-7 w-7 p-0 text-red-400 hover:text-red-600"
                      onClick={() => deleteTemplate(t.id)}
                      disabled={templates.length <= 1}
                    >
                      <Trash2 size={12} />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* ── formulario nueva plantilla ── */}
          {addingNew && (
            <div className="p-3 space-y-2 bg-muted/20">
              <Input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="Nombre de la plantilla"
                className="h-8 text-sm"
                autoFocus
              />
              <Textarea
                value={newBody}
                onChange={e => setNewBody(e.target.value)}
                rows={3}
                className="resize-y text-sm"
                placeholder="Texto del mensaje. Usá {nombre} y {telefono}."
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={confirmNew} className="h-7 px-3 text-xs">
                  <Check size={12} className="mr-1" /> Agregar
                </Button>
                <Button size="sm" variant="ghost" onClick={cancelNew} className="h-7 px-3 text-xs">
                  <X size={12} className="mr-1" /> Cancelar
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* preview del mensaje activo */}
        {activeTemplate && (
          <p className="text-xs text-muted-foreground px-1">
            <span className="font-medium">Preview:</span> {activeBody.slice(0, 120)}{activeBody.length > 120 ? '…' : ''}
          </p>
        )}
      </div>

      {/* ── Archivo ── */}
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground block">Archivo de contactos (.csv o .vcf)</label>
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
            <Upload size={15} className="mr-2" /> Seleccionar archivo
          </Button>
          <span className="text-sm text-muted-foreground">{fileName || 'Ningún archivo seleccionado'}</span>
          {recipients.length > 0 && (
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={clearAll}>
              <Trash2 size={14} className="mr-1" /> Limpiar
            </Button>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.vcf"
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
        />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* ── Tabla de contactos ── */}
      {recipients.length > 0 && (
        <div className="border rounded-lg overflow-hidden">
          <div className="px-3 py-2 text-xs text-muted-foreground bg-muted/40 border-b flex items-center justify-between">
            <span>
              {recipients.length} contacto{recipients.length === 1 ? '' : 's'} —
              plantilla: <span className="font-medium text-violet-600">{activeTemplate?.name}</span>
            </span>
            <span className="flex items-center gap-1">
              <CheckCircle2 size={13} className={sentCount > 0 ? 'text-green-600' : ''} />
              {sentCount}/{recipients.length} abiertos
            </span>
          </div>
          <div className="overflow-x-auto max-h-[480px]">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Teléfono</th>
                  <th className="text-left px-3 py-2 font-medium">Nombre</th>
                  <th className="text-left px-3 py-2 font-medium">Mensaje</th>
                  <th className="text-right px-3 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {recipients.map((r, idx) => (
                  <tr key={r.phone} className={`border-t ${r.sent ? 'bg-green-50/40' : ''}`}>
                    <td className="px-3 py-1.5 whitespace-nowrap">{r.phone}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">{r.name || '—'}</td>
                    <td className="px-3 py-1.5 text-muted-foreground truncate max-w-xs">{buildText(r)}</td>
                    <td className="px-3 py-1.5 text-right">
                      <Button size="sm" variant={r.sent ? 'ghost' : 'secondary'} onClick={() => openChat(r, idx)}>
                        <MessageSquareText size={13} className="mr-1.5" />
                        {r.sent ? 'Reabrir' : 'Abrir chat'}
                        <ExternalLink size={11} className="ml-1.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
