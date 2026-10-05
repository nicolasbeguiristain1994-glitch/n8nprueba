'use client'
import { useState } from 'react'
import { QUALITY_LABELS, type SegmentationProfile } from '@/lib/contact-segmentation'
import { Button } from '@/components/ui/button'

const money=(n:number|null|undefined)=>n==null?'Sin datos':new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',maximumFractionDigits:0}).format(n)
const date=(d:string|null|undefined)=>d?new Date(d.length===10?`${d}T12:00:00`:d).toLocaleDateString('es-AR'):'Sin datos'
export function SegmentationDetails({profile,quality,manual,onAutomatic}:{profile?:SegmentationProfile|null;quality?:string;manual?:boolean;onAutomatic:()=>Promise<void>}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  const stale=[...new Set((profile?.accounts??[]).filter(a=>!a.last_sync_at||Date.now()-Date.parse(a.last_sync_at)>48*3600000).map(a=>a.platform||'historial sin plataforma'))]
  return <section className="space-y-3 rounded-lg border p-3" aria-label="Explicación de segmentación">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Por qué tiene este nivel</h3><span className="text-xs text-muted-foreground">{QUALITY_LABELS[quality||'sin_datos']||'Sin datos'}</span></div>
    <p className="text-xs text-muted-foreground">Perfil global: consolida las cuentas vinculadas de todas las plataformas. Los bonos identificados se separan de los depósitos.</p>
    {manual&&<div className="rounded bg-amber-50 p-2 text-xs text-amber-900">Nivel elegido manualmente. El recálculo conserva esta elección.
      <Button size="sm" variant="ghost" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await onAutomatic()}catch(e){setError(e instanceof Error?e.message:'No se pudo restaurar el nivel')}finally{setBusy(false)}}}>Usar nivel calculado</Button>
    </div>}
    {!profile?<p className="text-sm">No hay un historial vinculado suficiente para calcular la actividad. No se interpreta como un contacto inactivo.</p>:<>
      <dl className="grid grid-cols-2 gap-3 text-xs">
        <div><dt className="text-muted-foreground">Promedio por mes activo</dt><dd className="font-semibold">{money(profile.monthly_average)}</dd></div>
        <div><dt className="text-muted-foreground">Meses con depósitos</dt><dd>{profile.active_months}</dd></div>
        <div><dt className="text-muted-foreground">Primera carga conocida</dt><dd>{date(profile.first_date)}</dd></div>
        <div><dt className="text-muted-foreground">Última carga conocida</dt><dd>{date(profile.last_date)}</dd></div>
        <div><dt className="text-muted-foreground">Depósitos en 30 días</dt><dd>{money(profile.amount_30d)} · {profile.deposits_30d??'—'} cargas</dd></div>
        <div><dt className="text-muted-foreground">Depósitos en 90 días</dt><dd>{money(profile.amount_90d)} · {profile.deposits_90d??'—'} cargas</dd></div>
      </dl>
      <p className="text-xs text-muted-foreground">Ventanas de 30/90 días hasta el {date(profile.as_of)}. Perfil recalculado el {date(profile.calculated_at)}. La actividad se actualiza por los días transcurridos desde el último depósito conocido.</p>
      {(profile.estimated||profile.partial_history)&&<p className="text-xs text-amber-800">El historial disponible es {profile.estimated?'estimado':'parcial'}. Los importes describen la información registrada.</p>}
      {stale.length>0&&<p className="rounded bg-amber-50 p-2 text-xs text-amber-900">Revisar actualización de {stale.join(', ')}: sin sincronización reciente confirmada. La actividad real podría ser más reciente que la registrada.</p>}
    </>}
    {error&&<p role="alert" className="text-xs text-destructive">{error}</p>}
  </section>
}
