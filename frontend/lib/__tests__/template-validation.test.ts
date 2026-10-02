import { describe, expect, it } from 'vitest'
import {
  CreateTemplateSchema, UpdateTemplateSchema, analyzeBodyVariables, buildBodyComponent,
  collectTemplateErrors, normalizeTemplateName, readBodyExamples, validateTemplateDraft,
} from '@/lib/template-validation'

const body = (text: string, examples?: string[]) =>
  examples ? { type: 'BODY', text, example: { body_text: [examples] } } : { type: 'BODY', text }
type Draft = Parameters<typeof validateTemplateDraft>[0]
const draft = (components: unknown[], extra: Record<string, unknown> = {}) =>
  ({ name: 'aviso_soporte', category: 'UTILITY', language: 'es', components, ...extra }) as Draft
const errorsOf = (components: unknown[], extra?: Record<string, unknown>) => {
  const result = validateTemplateDraft(draft(components, extra))
  return result.ok ? {} as Record<string, string> : result.errors
}

describe('template names', () => {
  it('normalizes case and whitespace the same way the API stores it', () => {
    expect(normalizeTemplateName('  Aviso \t Soporte\nGeneral ')).toBe('aviso_soporte_general')
    const parsed = CreateTemplateSchema.parse(draft([body('Hola')], { name: ' Aviso Soporte ' }))
    expect(parsed.name).toBe('aviso_soporte')
  })

  it.each(['aviso-soporte', 'avisó', 'aviso.soporte', '   ', '!!!'])('rejects %j with a Spanish message', name => {
    expect(errorsOf([body('Hola')], { name }).name).toMatch(/nombre/i)
  })

  it('limits names to the production column size (100)', () => {
    expect(errorsOf([body('Hola')], { name: 'a'.repeat(100) }).name).toBeUndefined()
    expect(errorsOf([body('Hola')], { name: 'a'.repeat(101) }).name).toContain('100')
  })
})

describe('BODY variables', () => {
  it('counts repeated positional variables once', () => {
    expect(analyzeBodyVariables('{{1}} {{2}} {{1}}')).toEqual({ variables: [1, 2], error: null })
  })

  it.each([
    ['{{ 1 }}', /mal escrita/], ['{{nombre}}', /mal escrita/], ['{{0}}', /mal escrita/],
    ['{{1}', /mal escrita/], ['Hola {{2}}', /Falta \{\{1\}\}/], ['{{1}} {{4}}', /Falta \{\{2\}\}, \{\{3\}\}/],
  ])('reports %j', (text, message) => {
    expect(analyzeBodyVariables(text).error).toMatch(message)
    expect(errorsOf([body(text, ['a', 'b', 'c', 'd'])]).body).toMatch(message)
  })

  it.each([
    'Hola {{{1}}}.', 'Hola {{{1}}.', 'Hola {{1}}}.', 'Hola }{{1}}.',
    'Hola {{1}}{.', 'Hola {{{1}}{{2}}.', 'Hola {{1}}}{{2}}.',
  ])('rejects extra braces next to variable tokens in %j', text => {
    expect(analyzeBodyVariables(text).error).toMatch(/mal escrita/)
    expect(errorsOf([body(text, ['Ana', 'A-1'])]).body).toMatch(/mal escrita/)
  })

  it('preserves literal braces and adjacent valid variables', () => {
    expect(analyzeBodyVariables('Opciones {consulta, ayuda}.')).toEqual({ variables: [], error: null })
    const text = 'Referencia { {{1}}{{2}} }; usar {opciones}.'
    expect(analyzeBodyVariables(text)).toEqual({ variables: [1, 2], error: null })
    expect(validateTemplateDraft(draft([body(text, ['A', '1'])])).ok).toBe(true)
  })

  it('requires one explicit, nonblank example per variable', () => {
    expect(errorsOf([body('Hola {{1}} {{2}}')]).bodyExamples).toContain('{{1}}, {{2}}')
    expect(errorsOf([body('Hola {{1}} {{2}}', ['Ana'])])['bodyExample.2']).toBe('Completá el ejemplo de {{2}}.')
    expect(errorsOf([body('Hola {{1}} {{2}}', ['Ana', '  '])])['bodyExample.2']).toBe('Completá el ejemplo de {{2}}.')
    expect(errorsOf([body('Hola {{1}}', ['Ana', 'extra'])]).bodyExamples).toMatch(/2 ejemplos/)
    expect(errorsOf([body('Hola', ['Ana'])]).bodyExamples).toMatch(/no tiene variables/)
    expect(errorsOf([{ type: 'BODY', text: 'Hola {{1}}', example: { body_text: 'Ana' } }]).bodyExamples).toMatch(/formato inválido/)
    expect(validateTemplateDraft(draft([body('Hola {{1}}, gracias {{1}}. Consulta {{2}}', ['Ana', 'A-1'])])).ok).toBe(true)
  })

  it('builds examples only from user input and reads them back for edit/duplicate', () => {
    expect(buildBodyComponent('Hola {{1}} {{2}}', ['Ana'])).toEqual(body('Hola {{1}} {{2}}', ['Ana', '']))
    expect(buildBodyComponent('Hola', ['Ana'])).toEqual(body('Hola'))
    const saved = [{ type: 'HEADER', format: 'IMAGE' }, body('Hola {{1}} {{2}}', ['Ana', 'A-1'])]
    expect(readBodyExamples(saved)).toEqual(['Ana', 'A-1'])
    expect(readBodyExamples([body('Hola')])).toEqual([])
  })
})

describe('components', () => {
  it('requires exactly one BODY and no duplicate components', () => {
    expect(errorsOf([]).body).toMatch(/BODY/)
    expect(errorsOf([{ type: 'FOOTER', text: 'Pie' }]).body).toMatch(/BODY/)
    expect(errorsOf([body('Hola'), body('Otra')]).body).toMatch(/repetido/)
  })

  it('rejects component types the local editor does not support', () => {
    expect(errorsOf([body('Hola'), { type: 'CAROUSEL', cards: [] }]).components).toMatch(/no soportado/)
  })

  it('rejects blank enabled header/footer instead of dropping them', () => {
    expect(errorsOf([{ type: 'HEADER', format: 'TEXT', text: ' ' }, body('Hola')]).header).toMatch(/encabezado/)
    expect(errorsOf([body('Hola'), { type: 'FOOTER', text: '' }]).footer).toMatch(/pie de página/)
    expect(validateTemplateDraft(draft([{ type: 'HEADER', format: 'DOCUMENT' }, body('Hola')])).ok).toBe(true)
  })

  it('validates buttons: 1-3, nonblank text, URL and phone values', () => {
    const buttons = (...b: unknown[]) => [body('Hola'), { type: 'BUTTONS', buttons: b }]
    expect(errorsOf(buttons()).buttons).toMatch(/al menos un botón/)
    const q = { type: 'QUICK_REPLY', text: 'Ok' }
    expect(errorsOf(buttons(q, q, q, q)).buttons).toMatch(/Máximo 3/)
    expect(errorsOf(buttons(q, { type: 'QUICK_REPLY', text: '  ' }))['button.1']).toMatch(/texto del botón/)
    expect(errorsOf(buttons({ type: 'URL', text: 'Ver' }))['button.0']).toMatch(/URL/)
    expect(errorsOf(buttons({ type: 'URL', text: 'Ver', url: 'javascript:alert(1)' }))['button.0']).toMatch(/URL válida/)
    expect(errorsOf(buttons({ type: 'URL', text: 'Ver', url: 'https://example.test/{{1}}' }))['button.0']).toMatch(/URL válida/)
    expect(errorsOf(buttons({ type: 'PHONE_NUMBER', text: 'Llamar', phone_number: '11 5555 0000' }))['button.0']).toMatch(/internacional/)
    expect(validateTemplateDraft(draft(buttons(q,
      { type: 'URL', text: 'Ver', url: 'https://example.test/ayuda' },
      { type: 'PHONE_NUMBER', text: 'Llamar', phone_number: '+5491100000000' },
    ))).ok).toBe(true)
  })

  it('accepts es_AR and keeps update fields optional', () => {
    expect(validateTemplateDraft(draft([body('Hola')], { language: 'es_AR' })).ok).toBe(true)
    expect(errorsOf([body('Hola')], { language: 'xx' }).language).toMatch(/idioma/)
    expect(UpdateTemplateSchema.safeParse({ status: 'BORRADOR' }).success).toBe(true)
    expect(UpdateTemplateSchema.safeParse({ components: [] }).success).toBe(false)
  })

  it('accepts both HTTP protocols and describes them in URL errors', () => {
    const withUrl = (url: string) => [body('Hola'), { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Ayuda', url }] }]
    for (const url of ['http://example.test/ayuda', 'https://example.test/ayuda']) {
      expect(validateTemplateDraft(draft(withUrl(url))).ok).toBe(true)
    }
    expect(errorsOf(withUrl('ftp://example.test/ayuda'))['button.0']).toContain('http:// o https://')
  })

  it('limits phone buttons to 15 digits after the international prefix', () => {
    const withPhone = (phone_number: string) => [body('Hola'), { type: 'BUTTONS', buttons: [{ type: 'PHONE_NUMBER', text: 'Llamar', phone_number }] }]
    expect(validateTemplateDraft(draft(withPhone('+123456789012345'))).ok).toBe(true)
    expect(errorsOf(withPhone('+1234567890123456'))['button.0']).toContain('15 dígitos')
    expect(errorsOf(withPhone('+12345678901234567890'))['button.0']).toContain('15 dígitos')
  })

  it('maps API issue paths back to editor fields', () => {
    const components = [{ type: 'HEADER', format: 'TEXT', text: '' }, body('Hola {{1}}', ['']), { type: 'BUTTONS', buttons: [] }]
    expect(collectTemplateErrors([
      { path: 'name', message: 'n' }, { path: 'components.0.text', message: 'h' },
      { path: 'components.1.example.body_text.0.0', message: 'e' }, { path: 'components.2.buttons', message: 'b' },
      { path: 'root', message: 'r' },
    ], components)).toEqual({ name: 'n', header: 'h', 'bodyExample.1': 'e', buttons: 'b', form: 'r' })
  })
})
