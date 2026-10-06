/** Active Ofizeus destinations provided by the operator on 2026-10-06.
 * Main lines have no variant. Never substitute a main line for an unknown variant.
 * These are displayed destinations, not sending credentials or Cloud sender IDs.
 */
export const OFIZEUS_LINES = [
  [1,'','ZEUS 1','5491125489456'],[1,'a','OFI 1A','5491164598463'],
  [2,'','ZEUS 2','5491125623142'],[3,'','ZEUS 3','5491154726043'],[3,'a','OFI 3A','5491124915455'],
  [4,'','ZEUS 4','5491125624422'],[4,'a','OFI 4A','5491154725918'],
  [5,'','ZEUS 5','5491178498067'],[5,'a','OFI 5A','5491164598145'],
  [6,'','ZEUS 6','5491125624363'],[7,'','ZEUS 7','5491125622774'],
  [8,'','ZEUS 8','5491160597743'],[8,'a','OFI 8A','5491140565762'],
  [9,'','ZEUS 9','5491125388962'],[9,'a','OFI 9A','5491162504611'],
  [10,'','ZEUS 10 VIP','5491125388755'],
] as const
export type RoutingContact = {first_name:string|null;panel:string|null;linea:number|string|null;linea_sub:string|null}
export const ADVISOR_FALLBACK = 'Gracias por escribirnos. Un asesor te atenderá para indicarte tu línea correspondiente.'
export function isOfizeus(contact: Pick<RoutingContact,'panel'>): boolean {return contact.panel?.trim().toLowerCase()==='ofizeus'}
export function ofizeusReply(contacts: RoutingContact[], prefix:string): {message:string;handoff:boolean} {
  if (contacts.length!==1 || !isOfizeus(contacts[0])) return {message:ADVISOR_FALLBACK,handoff:true}
  const c=contacts[0],variant=(c.linea_sub??'').trim().toLowerCase()
  const line=OFIZEUS_LINES.find(([n,v])=>c.linea!==null && Number(c.linea)===n && variant===v)
  if (!line) return {message:ADVISOR_FALLBACK,handoff:true}
  const formatted = `${line[3].slice(0,3)} | ${line[3].slice(3,7)} | ${line[3].slice(7)}`
  return {message:`${prefix.trim()}\n\n${line[2]} ${formatted}`,handoff:false}
}
