// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { prepareSticker, signStickerToken, verifyStickerToken } from '../conversation-stickers'

afterEach(()=>vi.unstubAllEnvs())
describe('conversation stickers',()=>{
  it('converts a rectangular PNG to a transparent padded 512 WebP within the provider limit',async()=>{
    const png=await sharp({create:{width:300,height:100,channels:4,background:'#ff0000'}}).png().toBuffer()
    const sticker=await prepareSticker(png),metadata=await sharp(sticker).metadata()
    expect(metadata).toMatchObject({width:512,height:512,format:'webp',hasAlpha:true})
    expect(sticker.length).toBeLessThanOrEqual(100*1024)
  })
  it('rejects oversized and non-image inputs',async()=>{
    await expect(prepareSticker(Buffer.alloc(5*1024*1024+1))).rejects.toThrow('5 MB')
    await expect(prepareSticker(Buffer.from('not an image'))).rejects.toThrow()
  })
  it('binds the upload token to its exact URL and operator, rejecting tampering and expiration',()=>{
    vi.stubEnv('AUTH_SECRET','unit-test-only-secret')
    const url='https://storage.test/sticker.webp',token=signStickerToken(url,'operator-a')
    expect(verifyStickerToken(token,url,'operator-a')).toBe(true)
    expect(verifyStickerToken(token,url,'operator-b')).toBe(false)
    expect(verifyStickerToken(token,url+'?changed','operator-a')).toBe(false)
    expect(verifyStickerToken(token+'x',url,'operator-a')).toBe(false)
    const now=Date.now();const spy=vi.spyOn(Date,'now').mockReturnValue(now+8*86400_000)
    expect(verifyStickerToken(token,url,'operator-a')).toBe(false);spy.mockRestore()
  })
})
