// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { downloadInboundMedia, MediaUnavailableError } from '../cloud-api/infrastructure/inbound-media'

afterEach(()=>vi.unstubAllGlobals())
const url='https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=123'
const info=(value=url)=>Response.json({url:value,mime_type:'image/webp'})
describe('private inbound WhatsApp media',()=>{
  it.each(['png','webp'] as const)('downloads %s with server credentials and keeps its original bytes',async format=>{
    const bytes=await sharp({create:{width:2,height:2,channels:4,background:'transparent'}}).toFormat(format).toBuffer()
    const fetcher=vi.fn().mockResolvedValueOnce(info()).mockResolvedValueOnce(new Response(new Uint8Array(bytes)))
    vi.stubGlobal('fetch',fetcher)
    const result=await downloadInboundMedia('123','456','secret')
    expect(result.bytes).toEqual(bytes);expect(result.mime).toBe('image/'+format)
    expect(fetcher.mock.calls[0][0]).toMatch(/\/123\?phone_number_id=456$/)
    expect(fetcher.mock.calls[1][0].toString()).toBe(url)
    for(const [,options] of fetcher.mock.calls)expect(options).toMatchObject({cache:'no-store',redirect:'error',headers:{Authorization:'Bearer secret'}})
  })
  it.each(['https://example.com/image','https://lookaside.fbsbx.com.evil.test/image','http://lookaside.fbsbx.com/image','https://user:password@lookaside.fbsbx.com/image','https://lookaside.fbsbx.com:444/image','http://127.0.0.1/image'])('never forwards credentials to untrusted URL %s',async value=>{
    const fetcher=vi.fn().mockResolvedValueOnce(info(value));vi.stubGlobal('fetch',fetcher)
    await expect(downloadInboundMedia('123','456','secret')).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('reports expired media and retries with a fresh lookup on the next call',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(null,{status:404}));vi.stubGlobal('fetch',fetcher)
    await expect(downloadInboundMedia('123','456','secret')).rejects.toBeInstanceOf(MediaUnavailableError)
    await expect(downloadInboundMedia('123','456','secret')).rejects.toBeInstanceOf(MediaUnavailableError)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('rejects oversized streams even when content-length is absent',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(info()).mockResolvedValueOnce(new Response(new Uint8Array(10*1024*1024+1)))
    vi.stubGlobal('fetch',fetcher)
    await expect(downloadInboundMedia('123','456','secret')).rejects.toThrow('Media too large')
  })
  it('never serves SVG or HTML as an image, regardless of provider MIME',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(info()).mockResolvedValueOnce(new Response('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><script>alert(1)</script></svg>'))
    vi.stubGlobal('fetch',fetcher)
    await expect(downloadInboundMedia('123','456','secret')).rejects.toThrow()
  })
  it.each([
    [Buffer.concat([Buffer.from('OggS'),Buffer.alloc(24),Buffer.from('OpusHead')]),'audio/ogg'],
    [Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00'),'audio/mpeg'],
    [Buffer.from([0xff,0xfb,0x90,0,0,0,0,0,0,0]),'audio/mpeg'],
    [Buffer.from([0xff,0xf1,0x50,0x80,0,0,0]),'audio/aac'],
    [Buffer.from('\x00\x00\x00\x18ftypM4A '),'audio/mp4'],
    [Buffer.from('#!AMR\n'),'audio/amr'],
  ])('detects audio from its bytes and preserves it for playback (%s)',async(bytes,mime)=>{
    const fetcher=vi.fn().mockResolvedValueOnce(info()).mockResolvedValueOnce(new Response(new Uint8Array(bytes as Buffer)))
    vi.stubGlobal('fetch',fetcher)
    const result=await downloadInboundMedia('123','456','secret','audio')
    expect(result.bytes).toEqual(bytes);expect(result.mime).toBe(mime)
  })
  it('rejects HTML disguised as audio',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(Response.json({url,mime_type:'audio/ogg'})).mockResolvedValueOnce(new Response('<html>not audio</html>')))
    await expect(downloadInboundMedia('123','456','secret','audio')).rejects.toThrow('Unsupported audio format')
  })
  it('bounds audio downloads to 16 MB',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({url,file_size:16*1024*1024+1}))
    vi.stubGlobal('fetch',fetcher)
    await expect(downloadInboundMedia('123','456','secret','audio')).rejects.toThrow('Media too large')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
