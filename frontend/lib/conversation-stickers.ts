import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import sharp from 'sharp'

export async function prepareSticker(input: Buffer): Promise<Buffer> {
  if (!input.length || input.length > 5*1024*1024) throw new Error('La imagen debe pesar hasta 5 MB.')
  const metadata = await sharp(input,{limitInputPixels:16_000_000,animated:true}).metadata()
  if (!['png','jpeg','webp'].includes(metadata.format || '')) throw new Error('Usá una imagen PNG, JPG o WebP.')
  if ((metadata.pages || 1)>1) {
    if (metadata.format!=='webp' || metadata.width!==512 || metadata.pageHeight!==512 || input.length>500*1024)
      throw new Error('El sticker animado debe ser WebP, de 512×512 y hasta 500 KB.')
    return input
  }
  for (const quality of [80,60,40,20]) {
    const output=await sharp(input,{limitInputPixels:16_000_000}).rotate().resize(512,512,{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).webp({quality,effort:4}).toBuffer()
    if(output.length<=100*1024) return output
  }
  throw new Error('No se pudo reducir el sticker a 100 KB. Probá una imagen más simple.')
}
export function signStickerToken(url:string,userId:string):string {
  if(!process.env.AUTH_SECRET) throw new Error('Autenticación no configurada')
  const payload=Buffer.from(JSON.stringify({hash:createHash('sha256').update(url).digest('hex'),userId,expires:Date.now()+7*86400_000})).toString('base64url')
  return payload+'.'+createHmac('sha256',process.env.AUTH_SECRET).update('sticker:'+payload).digest('base64url')
}
export function verifyStickerToken(token:string|undefined,url:string,userId:string):boolean {
  try {
    if(!token || !process.env.AUTH_SECRET) return false
    const [payload,signature,...rest]=token.split('.')
    if(rest.length || !signature) return false
    const expected=createHmac('sha256',process.env.AUTH_SECRET).update('sticker:'+payload).digest()
    const actual=Buffer.from(signature,'base64url')
    if(actual.length!==expected.length || !timingSafeEqual(actual,expected)) return false
    const data=JSON.parse(Buffer.from(payload,'base64url').toString())
    return data.hash===createHash('sha256').update(url).digest('hex') && data.userId===userId && data.expires>Date.now()
  } catch {return false}
}

export async function stickerPreview(data:string):Promise<string> {
  const bytes=Buffer.from(data.replace(/^data:image\/webp;base64,/,''),'base64')
  const thumb=await sharp(bytes,{limitInputPixels:16_000_000}).resize(160,160,{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).webp({quality:55}).toBuffer()
  return 'data:image/webp;base64,'+thumb.toString('base64')
}
