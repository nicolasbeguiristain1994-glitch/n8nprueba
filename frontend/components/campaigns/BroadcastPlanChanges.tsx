import { useState } from 'react'
import type { BroadcastPlan } from '@/lib/broadcast-planner'
import type { BroadcastCampaignDraft } from '@/lib/broadcast-plan-selection'
export function BroadcastPlanChanges({previous,plan}:{previous:BroadcastCampaignDraft;plan:BroadcastPlan}) {
  const [page,setPage]=useState(1)
  const selected=plan.contacts.filter(c=>!c.reason)
  const before=new Map(previous.recipients.map(c=>[c.id,c.lineId]))
  const after=new Set(selected.map(c=>c.id))
  const added=selected.filter(c=>!before.has(c.id)).length
  const removed=previous.recipients.filter(c=>!after.has(c.id)).length
  const moved=selected.filter(c=>before.has(c.id)&&before.get(c.id)!==c.lineId).length
  const names=new Map(plan.lines.map(l=>[l.id,l.name]))
  const pages=Math.max(1,Math.ceil(selected.length/50))
  return <div className="space-y-2">
    <p>{added} incorporados · {removed} retirados · {moved} con otra línea</p>
    <details><summary className="cursor-pointer underline">Revisar los destinatarios actualizados</summary>
      <div className="max-h-64 overflow-auto"><table className="w-full text-left text-xs"><thead><tr><th className="p-2">Contacto</th><th className="p-2">Línea</th></tr></thead>
        <tbody>{selected.slice((page-1)*50,page*50).map(c=><tr key={c.id} className="border-t"><td className="p-2">{c.name || 'Sin nombre'}<span className="block text-muted-foreground">{c.phone}</span></td><td className="p-2">{names.get(c.lineId!)}</td></tr>)}</tbody>
      </table></div>
      <div className="flex items-center justify-end gap-3 text-xs"><button type="button" disabled={page<=1} onClick={()=>setPage(p=>p-1)}>Anterior</button><span>{page} / {pages}</span><button type="button" disabled={page>=pages} onClick={()=>setPage(p=>p+1)}>Siguiente</button></div>
    </details>
  </div>
}
