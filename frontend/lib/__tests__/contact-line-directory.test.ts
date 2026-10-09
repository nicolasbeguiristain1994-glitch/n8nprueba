import {describe,it,expect} from 'vitest'
import {OFIZEUS_LINES,ofizeusReply} from '../contact-line-directory'
describe('Ofizeus active line directory',()=>{
 it.each(OFIZEUS_LINES)('resolves line %s variant %s to %s',(linea,linea_sub,label,phone)=>{
  expect(ofizeusReply([{first_name:'Ana',panel:' OFIZEUS ',linea,linea_sub}], 'Tu línea:')).toEqual({message:`Tu línea:\n\n${label} ${phone.slice(0,3)} | ${phone.slice(3,7)} | ${phone.slice(7)}`,handoff:false})
 })
 it.each([null,'','a','b','c',' B '])('routes Line 1 variant %s to the operator-designated common destination',linea_sub=>{
  const contact={first_name:'Cliente',panel:'ofizeus',linea:'1',linea_sub}
  expect(ofizeusReply([contact],'Tu línea es {{2}}')).toEqual({message:'Tu línea es 549 | 1125 | 489456',handoff:false})
  expect(ofizeusReply([contact],'Tu línea:')).toEqual({message:'Tu línea:\n\nZEUS 1 549 | 1125 | 489456',handoff:false})
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
