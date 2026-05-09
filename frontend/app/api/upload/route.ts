import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkPermission } from '@/lib/permissions'

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const MAX_SIZE_MB   = 10
const MAX_BYTES     = MAX_SIZE_MB * 1024 * 1024

export async function POST(req: NextRequest) {
  const err = await checkPermission(req, 'campaigns', 'create')
  if (err) return err

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_KEY
  const bucket      = process.env.STORAGE_BUCKET || 'whatsapp-media'

  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json({ error: 'Storage no configurado (SUPABASE_URL / SUPABASE_KEY)' }, { status: 500 })
  }

  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Payload inválido' }, { status: 400 })
  }

  const file = formData.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Se requiere un archivo en el campo "file"' }, { status: 400 })
  }

  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json({ error: 'Tipo de archivo no permitido. Usá JPG, PNG, WEBP o GIF.' }, { status: 400 })
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `El archivo supera el límite de ${MAX_SIZE_MB} MB` }, { status: 400 })
  }

  const ext      = file.name.split('.').pop()?.toLowerCase() || 'jpg'
  const fileName = `campaign-media/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`

  const supabase = createClient(supabaseUrl, supabaseKey)
  const buffer   = await file.arrayBuffer()

  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(fileName, buffer, { contentType: file.type, upsert: false })

  if (uploadError) {
    console.error('[/api/upload]', uploadError.message)
    return NextResponse.json({ error: `Error al subir: ${uploadError.message}` }, { status: 500 })
  }

  const { data } = supabase.storage.from(bucket).getPublicUrl(fileName)
  return NextResponse.json({ url: data.publicUrl })
}
