'use client'
import { useState, useRef, useCallback } from 'react'
import * as XLSX from 'xlsx'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Upload, MessageSquareText, ExternalLink, Trash2, CheckCircle2 } from 'lucide-react'
import { normalizePhone } from '@/lib/validate'
import { PageHeader } from '@/components/layout/PageHeader'

interface Recipient {
  phone: string
  name?: string
  sent?: boolean
}

const DEFAULT_MESSAGE = 'Hola {nombre}! Te escribo desde GBecon.'

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

export default function EnvioWhatsappPage() {
  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [message, setMessage]       = useState(DEFAULT_MESSAGE)
  const [fileName, setFileName]     = useState('')
  const [error, setError]           = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

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
        // dedupe
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
    return message
      .replaceAll('{nombre}', r.name || '')
      .replaceAll('{telefono}', r.phone)
  }, [message])

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

  return (
    <div className="space-y-5">
      <PageHeader
        title="Envío por WhatsApp"
        description="Subí contactos (CSV o VCF), escribí el mensaje y abrí cada chat con el texto pre-armado. El envío final lo confirmás vos en WhatsApp."
      />

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

      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground block">
          Mensaje (variables: {'{nombre}'} y {'{telefono}'})
        </label>
        <Textarea
          value={message}
          onChange={e => setMessage(e.target.value)}
          rows={4}
          className="resize-y"
        />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {recipients.length > 0 && (
        <div className="border rounded-lg overflow-hidden">
          <div className="px-3 py-2 text-xs text-muted-foreground bg-muted/40 border-b flex items-center justify-between">
            <span>{recipients.length} contacto{recipients.length === 1 ? '' : 's'} listos para enviar</span>
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
