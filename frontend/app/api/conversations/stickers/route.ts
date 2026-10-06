import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { prepareSticker, signStickerToken } from '@/lib/conversation-stickers'

export async function POST(req:NextRequest) {
  const auth=await checkPermissionWithUser(req,'send','send')
  if(!auth.ok) return auth.response
  if(Number(req.headers.get('content-length'))>6*1024*1024) return NextResponse.json({error:'La imagen supera 5 MB.'},{status:413})
  let image:Buffer
  try {
    const form=await req.formData(),file=form.get('file')
    if(!(file instanceof File)) throw new Error('Elegí una imagen para el sticker.')
    if(file.size>5*1024*1024) throw new Error('La imagen supera 5 MB.')
    image=await prepareSticker(Buffer.from(await file.arrayBuffer()))
  } catch(e) {return NextResponse.json({error:e instanceof Error?e.message:'Imagen inválida'},{status:400})}
  const url='data:image/webp;base64,'+image.toString('base64')
  return NextResponse.json({url,token:signStickerToken(url,auth.user.user_id)})
}
