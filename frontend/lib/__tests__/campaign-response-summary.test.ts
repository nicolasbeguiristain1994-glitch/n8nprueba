import { describe, expect, it } from 'vitest'
import { responseCandidates, summarizeResponses } from '@/lib/campaign-response-summary'

describe('campaign response classification', () => {
  it('does not treat media captions or non-button interactions as commands', () => {
    expect(responseCandidates('image', {image:{caption:'BAJA'}})).toEqual([])
    expect(responseCandidates('interactive', {interactive:{type:'list_reply',list_reply:{title:'BAJA'}}})).toEqual([])
    expect(responseCandidates('text', {text:{body:'EXTRA'}})).toEqual(['EXTRA'])
  })
  it('handles configured custom options, exact matching, BAJA precedence and repeated people', () => {
    const components=[{type:'BUTTONS',buttons:[{type:'QUICK_REPLY',text:'Más info'},{type:'QUICK_REPLY',text:'BAJA'},{type:'URL',text:'Visitar'}]}]
    const params={buttons:[{index:0,sub_type:'quick_reply',payload:'info-7'}]}
    const summary=summarizeResponses(components,params,[
      {phone:'+549 11',candidates:['info-7'],count:2},
      {phone:'54911',candidates:['más   info'],count:1},
      {phone:'54911',candidates:['BAJA','Más info'],count:1},
      {phone:'54922',candidates:['quiero más info'],count:1},
    ])
    expect(summary).toEqual({personas:2,opciones:[{label:'BAJA',mensajes:1,personas:1},{label:'MÁS INFO',mensajes:3,personas:1},{label:'Otras respuestas',mensajes:1,personas:1}]})
  })
  it('shows zero options without inventing respondents', () => {
    expect(summarizeResponses(null,null,[])).toEqual({personas:0,opciones:[{label:'BAJA',mensajes:0,personas:0},{label:'Otras respuestas',mensajes:0,personas:0}]})
  })
})
