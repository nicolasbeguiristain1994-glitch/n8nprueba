'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const MAX_BYTES = 5 * 1024 * 1024
export function LineProfilePhoto({ lineId, name, phone }: { lineId: string; name: string; phone: string }) {
  const endpoint = `/api/lines/${encodeURIComponent(lineId)}/profile-photo`
  const [open, setOpen] = useState(false)
  const [pictureUrl, setPictureUrl] = useState<string | null>(null)
  const [canEdit, setCanEdit] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [brokenImage, setBrokenImage] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const savingRef = useRef(false)
  const request = useRef<AbortController | null>(null)
  const load = useCallback(async () => {
    request.current?.abort()
    const controller = new AbortController(); request.current = controller
    setLoading(true); setError('')
    try {
      const response = await fetch(endpoint, { cache: 'no-store', signal: controller.signal })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'No se pudo cargar la foto.')
      if (controller.signal.aborted) return
      setPictureUrl(data.pictureUrl); setCanEdit(data.canEdit === true); setBrokenImage(false)
    } catch (error) {
      if (!controller.signal.aborted) { setError(error instanceof Error ? error.message : 'No se pudo cargar la foto.'); setCanEdit(false) }
    } finally { if (!controller.signal.aborted) setLoading(false) }
  }, [endpoint])
  useEffect(() => { void load(); return () => request.current?.abort() }, [load])
  useEffect(() => {
    if (!file) { setPreview(null); return }
    const url = URL.createObjectURL(file); setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])
  const close = () => {
    if (savingRef.current) return
    setOpen(false); setFile(null); setNotice('')
  }
  const choose = (selected?: File) => {
    setNotice(''); setFile(null)
    if (!selected) return
    if (!['image/jpeg', 'image/png'].includes(selected.type)) { setError('Elegí una imagen JPG o PNG.'); return }
    if (!selected.size || selected.size > MAX_BYTES) { setError('La imagen debe pesar hasta 5 MB.'); return }
    setError(''); setFile(selected)
  }
  const save = async () => {
    if (!file || !canEdit || savingRef.current) return
    savingRef.current = true; setSaving(true); setError(''); setNotice('')
    request.current?.abort()
    try {
      const form = new FormData(); form.set('file', file)
      const response = await fetch(endpoint, { method: 'POST', body: form })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudo confirmar el cambio. Actualizá la foto antes de volver a guardar.')
      if (!data.refreshPending) { setPictureUrl(data.pictureUrl); setBrokenImage(false) }
      setFile(null)
      if (input.current) input.current.value = ''
      setNotice(data.refreshPending
        ? 'Meta confirmó el cambio. Pulsá Actualizar foto para ver la nueva imagen.'
        : 'Foto guardada en WhatsApp. Puede tardar unos minutos en verse en todos los dispositivos.')
    } catch (error) {
      setError(error instanceof Error ? error.message : 'No se pudo confirmar el cambio. Actualizá la foto antes de volver a guardar.')
    } finally { savingRef.current = false; setSaving(false) }
  }
  const currentImage = !brokenImage && pictureUrl
  return <>
    <button type="button" aria-label={`Foto de WhatsApp de ${name}`} title={`Foto de WhatsApp de ${name}`}
      onClick={() => setOpen(true)} className="flex shrink-0 flex-col items-center gap-1 rounded-md p-1 text-primary hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary">
      <span className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border bg-muted">
        {loading ? <Loader2 size={18} className="animate-spin" /> : currentImage
          ? <img src={currentImage} alt={`Foto de ${name}`} className="h-full w-full object-cover" referrerPolicy="no-referrer" onError={() => setBrokenImage(true)} />
          : <Camera size={18} className="text-muted-foreground" />}
      </span>
      <span className="text-[10px]">Foto</span>
    </button>
    <Dialog open={open} onOpenChange={value => { if (value) setOpen(true); else close() }}>
      <DialogContent showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>Foto de WhatsApp · {name}</DialogTitle>
          <DialogDescription>{phone || name}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-48 w-48 items-center justify-center overflow-hidden rounded-full border bg-white">
            {preview || currentImage ? <img src={preview || currentImage || ''} alt={preview ? 'Vista previa de la nueva foto' : `Foto actual de ${name}`}
              className="h-full w-full object-cover" referrerPolicy="no-referrer"
              onError={() => { if (preview) { setFile(null); setError('No se pudo leer la imagen. Elegí otro archivo JPG o PNG.') } else setBrokenImage(true) }} />
              : loading ? <Loader2 className="animate-spin text-primary" size={32} /> : <Camera size={42} className="text-muted-foreground" />}
          </div>
          <p className="text-sm text-muted-foreground">{preview ? 'Vista previa del recorte' : loading ? 'Consultando foto…' : error || brokenImage ? 'Foto no disponible' : currentImage ? 'Foto actual' : 'Sin foto de perfil'}</p>
          <Button variant="outline" size="sm" disabled={loading || saving} onClick={() => void load()}>
            <RefreshCw size={14} className={loading ? 'mr-1 animate-spin' : 'mr-1'} /> Actualizar foto
          </Button>
        </div>
        {error && <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
        {notice && <p role="status" className="rounded-md bg-success/10 p-3 text-sm text-success">{notice}</p>}
        {canEdit && <div className="space-y-2">
          <label htmlFor={`photo-${lineId}`} className="text-sm font-medium">Elegir nueva foto</label>
          <input ref={input} id={`photo-${lineId}`} type="file" accept="image/jpeg,image/png" disabled={saving}
            className="block w-full min-w-0 rounded-md border p-2 text-sm file:mr-2 file:rounded file:border-0 file:bg-accent file:px-2 file:py-1 file:text-primary"
            onChange={event => choose(event.target.files?.[0])} />
          <p className="text-xs text-muted-foreground">JPG o PNG, hasta 5 MB. Se aplica el recorte central que ves en la vista previa.</p>
        </div>}
        {!canEdit && !loading && !error && <p className="text-sm text-muted-foreground">Solo el propietario o un administrador puede cambiar esta foto.</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={close} disabled={saving}>{notice ? 'Cerrar' : 'Cancelar'}</Button>
          {canEdit && <Button onClick={() => void save()} disabled={!file || !preview || saving || loading}>
            {saving && <Loader2 size={14} className="mr-1 animate-spin" />}{saving ? 'Guardando…' : 'Guardar foto'}
          </Button>}
        </div>
      </DialogContent>
    </Dialog>
  </>
}
