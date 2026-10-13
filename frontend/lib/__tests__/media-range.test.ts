import { describe, expect, it } from 'vitest'
import { mediaRange } from '../media-range'

describe('native audio ranges',()=>{
  it.each([
    ['bytes=0-1',{start:0,end:1}],['bytes=4-',{start:4,end:9}],
    ['bytes=-3',{start:7,end:9}],['bytes=2-99',{start:2,end:9}],['bytes=-99',{start:0,end:9}],
  ])('handles %s', (header,expected)=>expect(mediaRange(header,10)).toEqual(expected))
  it.each(['bytes=-','bytes=-0','bytes=10-','bytes=5-2','bytes=0-1,3-4','items=0-1','bytes=9007199254740992-','bytes=one-two'])('rejects invalid range %s',header=>{
    expect(mediaRange(header,10)).toBeNull()
  })
  it('rejects a range for an empty file',()=>expect(mediaRange('bytes=0-',0)).toBeNull())
})
