import { META_BASE_URL } from '../types/domain'

export async function uploadCloudSticker(phoneNumberId:string,accessToken:string,data:string):Promise<string> {
  const bytes=Buffer.from(data.replace(/^data:image\/webp;base64,/,''),'base64')
  const form=new FormData()
  form.set('messaging_product','whatsapp');form.set('type','image/webp')
  form.set('file',new Blob([new Uint8Array(bytes)],{type:'image/webp'}),'sticker.webp')
  const response=await fetch(`${META_BASE_URL}/${phoneNumberId}/media`,{method:'POST',headers:{Authorization:`Bearer ${accessToken}`},body:form,signal:AbortSignal.timeout(15_000)})
  const result=await response.json().catch(()=>null)
  if(!response.ok || typeof result?.id!=='string')throw new Error('WhatsApp no pudo cargar el sticker. No se envió el mensaje.')
  return result.id
}
