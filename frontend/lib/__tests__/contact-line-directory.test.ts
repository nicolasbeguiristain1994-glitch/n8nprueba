import {describe,it,expect} from 'vitest'
import {OFIZEUS_LINES,ofizeusReply,agentLineReply,ADVISOR_FALLBACK} from '../contact-line-directory'
describe('Ofizeus active line directory',()=>{
 it.each(OFIZEUS_LINES)('resolves line %s variant %s to %s',(linea,linea_sub,label,phone)=>{
  expect(ofizeusReply([{first_name:'Ana',panel:' OFIZEUS ',linea,linea_sub}], 'Tu línea:')).toEqual({message:`Tu línea:\n\n${label} ${phone.slice(0,3)} | ${phone.slice(3,7)} | ${phone.slice(7)}`,handoff:false})
 })
 it('replaces the exact user message in place without adding name or a duplicate footer',()=>{
  const message='Hola! Envia la palabra EXTRA a tu linea designada para habilitar el regalo 🎁\nSuerte! 🍀\nLines designada: {{2}}'
  expect(ofizeusReply([{first_name:'Ana',panel:'ofizeus',linea:3,linea_sub:'a'}],message)).toEqual({message:'Hola! Envia la palabra EXTRA a tu linea designada para habilitar el regalo 🎁\nSuerte! 🍀\nLines designada: 549 | 1124 | 915455',handoff:false})
 })
 it('replaces every occurrence, supports token whitespace, and preserves other variables',()=>{
  expect(ofizeusReply([{first_name:'Ana',panel:'ofizeus',linea:3,linea_sub:'a'}],'{{nombre}}: {{2}} / {{ 2 }}').message).toBe('{{nombre}}: 549 | 1124 | 915455 / 549 | 1124 | 915455')
 })
 it('never sends an unresolved number placeholder when no destination exists',()=>{
  const result=ofizeusReply([{first_name:'Ana',panel:'ofizeus',linea:3,linea_sub:'b'}],'Tu línea: {{2}}')
  expect(result.handoff).toBe(true);expect(result.message).not.toContain('{{2}}')
 })
 it.each([{linea:3,linea_sub:'b'},{linea:12,linea_sub:null},{linea:null,linea_sub:null},{linea:10,linea_sub:'a'}])('does not guess inactive or missing assignments: %j',assignment=>{
  expect(ofizeusReply([{first_name:'Ana',panel:'ofizeus',...assignment}], 'Tu línea').handoff).toBe(true)
 })
 it('rejects unknown, other-agent and ambiguous contacts',()=>{
  const c={first_name:'Ana',panel:'royal',linea:3,linea_sub:null}
  expect(ofizeusReply([c], 'Tu línea').handoff).toBe(true)
  expect(ofizeusReply([], 'Tu línea').handoff).toBe(true)
  expect(ofizeusReply([{...c,panel:'ofizeus'},{...c,panel:'ofizeus'}], 'Tu línea').handoff).toBe(true)
 })
})


describe('agent-specific line routing',()=>{
 const directory = [[1,'','Royal 1','5491100000001'],[1,'a','Royal 1A','5491100000002']] as const
 const contact = {first_name:'Ana',panel:' ROYAL ',linea:1,linea_sub:null}
 it('resolves the configured agent and exact variant with synthetic destinations',()=>{
  expect(agentLineReply([contact],'royal','Tu línea: {{2}}',directory)).toEqual({message:'Tu línea: 549 | 1100 | 000001',handoff:false})
  expect(agentLineReply([{...contact,linea_sub:'A'}],'royal','{{2}}',directory).message).toBe('549 | 1100 | 000002')
 })
 it.each([
  {...contact,linea:5}, {...contact,linea_sub:'b'}, {...contact,panel:'ofizeus'},
 ])('never substitutes another agent, line or variant: %j',c=>{
  expect(agentLineReply([c],'royal','Tu línea: {{2}}',directory)).toEqual({message:ADVISOR_FALLBACK,handoff:true})
 })
 it('requires one unambiguous contact and an active directory entry',()=>{
  for(const contacts of [[],[contact,contact]]) expect(agentLineReply(contacts,'royal','{{2}}',directory).handoff).toBe(true)
  expect(agentLineReply([contact],'royal','{{2}}',[]).handoff).toBe(true)
 })
})
