const COLORS: Record<string,string> = {
  royal:'#1d4ed8', ofizeus:'#7e22ce', bigwin:'#15803d', betcoin:'#b45309',
  farabet:'#be185d', lasvegas:'#0e7490', imperio:'#b91c1c', adminbet:'#4338ca', surmar:'#57534e',
}
export function AgentBadge({agent}:{agent?:string|null}) {
  const name=agent?.trim().toLowerCase()
  let hash=0
  for(const char of name || '') hash=(hash*31+char.charCodeAt(0))>>>0
  const color=name ? COLORS[name] || `hsl(${hash%360} 65% 32%)` : '#64748b'
  return <span title={`Agente: ${name || 'sin asignar'}`} className="inline-flex max-w-full items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold" style={{color,borderColor:color,backgroundColor:'white'}}>
    <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full" style={{backgroundColor:color}}/>{name || 'Sin agente'}
  </span>
}
