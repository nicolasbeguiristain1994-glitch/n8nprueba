import {describe,it,expect} from 'vitest'
import {OFIZEUS_LINES,ofizeusReply} from '../contact-line-directory'
describe('Ofizeus active line directory',()=>{
 it.each(OFIZEUS_LINES)('resolves line %s variant %s to %s',(linea,linea_sub,label,phone)=>{
  expect(ofizeusReply([{first_name:'Ana',panel:' OFIZEUS ',linea,linea_sub}], 'Tu línea:')).toEqual({message:`Tu línea:\n\n${label} ${phone.slice(0,3)} | ${phone.slice(3,7)} | ${phone.slice(7)}`,handoff:false})
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
