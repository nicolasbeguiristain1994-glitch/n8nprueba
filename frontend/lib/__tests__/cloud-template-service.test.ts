/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TemplateService } from '@/lib/cloud-api/infrastructure/template.service'
import type { MetaTemplate } from '@/lib/cloud-api/types/templates'

const { get } = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/lib/cloud-api/infrastructure/meta-http.gateway', () => ({
  MetaHttpGateway: class { get = get },
}))

function template(index: number): MetaTemplate {
  return {
    id: `template-${index}`, name: `welcome_${index}`, status: 'APPROVED',
    category: 'MARKETING', language: 'es_AR', components: [{ type: 'BODY', text: 'Hola' }],
  }
}
function nextPage(index: number, after: string) {
  return { data: [template(index)], paging: { next: 'https://example.test/next', cursors: { after } } }
}

beforeEach(() => vi.resetAllMocks())

describe('TemplateService.list complete catalog pagination', () => {
  it('collects every page and encodes opaque cursors while retaining the WABA, fields and page size', async () => {
    const cursor = 'next+/=&? page'
    get.mockResolvedValueOnce(nextPage(1, cursor))
      .mockResolvedValueOnce(nextPage(2, 'last-page'))
      .mockResolvedValueOnce({ data: [template(3)], paging: { cursors: { after: 'terminal-cursor' } } })

    await expect(new TemplateService('local-test-token').list('waba-1', 25))
      .resolves.toEqual([template(1), template(2), template(3)])

    expect(get).toHaveBeenCalledTimes(3)
    const paths = get.mock.calls.map(([path]) => new URL(path, 'https://example.test'))
    for (const path of paths) {
      expect(path.pathname).toBe('/waba-1/message_templates')
      expect(path.searchParams.get('limit')).toBe('25')
      expect(path.searchParams.get('fields')?.split(',')).toEqual(
        expect.arrayContaining(['id', 'name', 'status', 'category', 'language', 'components']),
      )
    }
    expect(paths.map(path => path.searchParams.get('after'))).toEqual([null, cursor, 'last-page'])
  })

  it('returns an empty complete catalog without fetching another page', async () => {
    get.mockResolvedValue({ data: [] })
    await expect(new TemplateService('local-test-token').list('waba-1')).resolves.toEqual([])
    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0][0]).toContain('limit=100')
  })

  it.each([undefined, {}, { after: '' }])('rejects a next page without a usable cursor: %j', async cursors => {
    get.mockResolvedValue({ data: [template(1)], paging: { next: 'https://example.test/next', cursors } })
    await expect(new TemplateService('local-test-token').list('waba-1'))
      .rejects.toThrow('Paginación de plantillas incompleta')
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('rejects a repeated cursor even when the cycle spans several pages', async () => {
    get.mockResolvedValueOnce(nextPage(1, 'cursor-a'))
      .mockResolvedValueOnce(nextPage(2, 'cursor-b'))
      .mockResolvedValueOnce(nextPage(3, 'cursor-a'))
    await expect(new TemplateService('local-test-token').list('waba-1'))
      .rejects.toThrow('Paginación de plantillas incompleta')
    expect(get).toHaveBeenCalledTimes(3)
  })

  it('rejects an incomplete catalog at the 100-page limit instead of returning partial data', async () => {
    let page = 0
    get.mockImplementation(async () => nextPage(++page, `cursor-${page}`))
    await expect(new TemplateService('local-test-token').list('waba-1'))
      .rejects.toThrow('La consulta de plantillas superó el límite de páginas')
    expect(get).toHaveBeenCalledTimes(100)
  })

  it('accepts a catalog that finishes exactly on page 100', async () => {
    let page = 0
    get.mockImplementation(async () => {
      page++
      return page === 100 ? { data: [template(page)] } : nextPage(page, `cursor-${page}`)
    })
    const result = await new TemplateService('local-test-token').list('waba-1')
    expect(result).toEqual(Array.from({ length: 100 }, (_, index) => template(index + 1)))
    expect(get).toHaveBeenCalledTimes(100)
  })

  it('propagates a later-page failure instead of exposing the already fetched partial catalog', async () => {
    const failure = new Error('Mock gateway unavailable')
    get.mockResolvedValueOnce(nextPage(1, 'cursor-a')).mockRejectedValueOnce(failure)
    await expect(new TemplateService('local-test-token').list('waba-1')).rejects.toBe(failure)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('rejects malformed data on a later page', async () => {
    get.mockResolvedValueOnce(nextPage(1, 'cursor-a')).mockResolvedValueOnce({ data: null })
    await expect(new TemplateService('local-test-token').list('waba-1'))
      .rejects.toThrow('Respuesta de plantillas inválida')
    expect(get).toHaveBeenCalledTimes(2)
  })
})
