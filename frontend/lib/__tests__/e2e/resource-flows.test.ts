// @vitest-environment node
/**
 * Flujos E2E de recursos — Template y Automation.
 *
 * Test 1 — Template POST: validación Zod + regla de negocio + creación + audit
 *   Pasos: schema inválido → 400; schema válido sin BODY → 400 (regla de negocio);
 *          payload completo → 201 + audit(create, templates).
 *
 * Test 2 — Template PATCH: actualización parcial → metadata.fields exacto
 *   Pasos: un campo → fields=['status']; dos campos → fields=['status','rejection_reason'].
 *
 * Test 3 — Automation POST: validación Zod + creación + audit
 *   Pasos: campo requerido ausente → 400; trigger_type inválido → 400;
 *          payload válido → 201 + audit(create, automations).
 *
 * Ejecutar: npx vitest run lib/__tests__/e2e/resource-flows.test.ts
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────
vi.mock('@/lib/db', () => ({
  query:           vi.fn(),
  getDbClient:     vi.fn(),
  withTransaction: vi.fn(),
  pool:            { totalCount: 0, idleCount: 0, waitingCount: 0 },
}))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))

import { POST  as templatesPost  } from '@/app/api/templates/route'
import { PATCH as templatesPatch  } from '@/app/api/templates/[id]/route'
import { POST  as automationsPost } from '@/app/api/automations/route'
import * as db                       from '@/lib/db'
import * as auditLib                 from '@/lib/audit'
import type { AuditEvent }           from '@/lib/audit'
import {
  makeAdminSession, adminPost, adminPatch,
  TEST_AUTH_SECRET,
} from '@/lib/__tests__/helpers/session'

// ── Constants ─────────────────────────────────────────────────────────────────

const TEMPLATES_URL    = 'http://localhost/api/templates'
const TEMPLATE_ID      = 'eeeeeeee-0000-0000-0000-eeeeeeeeeeee'
const TEMPLATE_URL     = `${TEMPLATES_URL}/${TEMPLATE_ID}`
const AUTOMATIONS_URL  = 'http://localhost/api/automations'
const TEMPLATE_PARAMS  = { params: Promise.resolve({ id: TEMPLATE_ID }) }

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(() => { process.env.AUTH_SECRET = TEST_AUTH_SECRET })
beforeEach(() => { vi.resetAllMocks() })

// ── DB mock helpers ───────────────────────────────────────────────────────────

/** Mock the RBAC check: returns an admin row for checkPermissionWithUser. */
function mockAdminCheck(): void {
  vi.mocked(db.query).mockResolvedValueOnce([{
    role: 'admin', sectors: [], is_active: true,
    session_version: 1, can_download_contacts: true, allowed_agents: [],
  }] as never)
}

/** Mock a successful INSERT/UPDATE that returns a new resource id. */
function mockInsert(id: string): void {
  vi.mocked(db.query).mockResolvedValueOnce([{ id }] as never)
}

// ── Audit helpers ─────────────────────────────────────────────────────────────

function getAuditCall(action: string): AuditEvent | undefined {
  return vi.mocked(auditLib.audit).mock.calls
    .map(([e]) => e)
    .find(e => e.action === action)
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test 1 — Template POST: validación + regla de negocio + creación + audit
// ═══════════════════════════════════════════════════════════════════════════════

describe('Test 1 — Template POST: validación Zod, regla BODY y creación exitosa', () => {

  // ── Paso 1a: validación de schema ──────────────────────────────────────────

  it('paso 1a — falta name → 400 con issue en campo "name"', async () => {
    const admin = makeAdminSession()
    mockAdminCheck()

    const res  = await templatesPost(adminPost(TEMPLATES_URL, admin, { category: 'UTILITY' }) as never)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Validation failed')
    expect(body.issues.some((i: { path: string }) => i.path === 'name')).toBe(true)
  })

  it('paso 1a — category inválida → 400 con issue en campo "category"', async () => {
    const admin = makeAdminSession()
    mockAdminCheck()

    const res  = await templatesPost(
      adminPost(TEMPLATES_URL, admin, { name: 'promo_test', category: 'INVALIDA' }) as never
    )
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Validation failed')
    expect(body.issues.some((i: { path: string }) => i.path === 'category')).toBe(true)
  })

  it('paso 1a — error de validación no genera audit create (solo validation_failed)', async () => {
    const admin = makeAdminSession()
    mockAdminCheck()

    await templatesPost(adminPost(TEMPLATES_URL, admin, { category: 'MARKETING' }) as never)

    expect(getAuditCall('create')).toBeUndefined()
  })

  // ── Paso 1b: regla de negocio — componente BODY obligatorio ───────────────

  it('paso 1b — schema válido pero sin componente BODY → 400 con mensaje de negocio', async () => {
    const admin = makeAdminSession()
    mockAdminCheck()
    // components pasa la validación Zod (array de objetos genéricos) pero ninguno tiene type=BODY
    const res  = await templatesPost(
      adminPost(TEMPLATES_URL, admin, {
        name:       'promo_test',
        category:   'MARKETING',
        components: [{ type: 'HEADER', text: 'Título' }],
      }) as never
    )
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toContain('BODY')
  })

  it('paso 1b — regla de negocio no genera audit create', async () => {
    const admin = makeAdminSession()
    mockAdminCheck()

    await templatesPost(
      adminPost(TEMPLATES_URL, admin, {
        name:       'promo_test',
        category:   'MARKETING',
        components: [{ type: 'HEADER', text: 'Título' }],
      }) as never
    )

    expect(getAuditCall('create')).toBeUndefined()
  })

  // ── Paso 2: creación exitosa ───────────────────────────────────────────────

  it('paso 2 — payload válido con BODY → 201 con el id del nuevo template', async () => {
    const admin = makeAdminSession()
    const newId = 'dddddddd-1111-0000-0000-dddddddddddd'
    mockAdminCheck()
    mockInsert(newId)

    const res  = await templatesPost(
      adminPost(TEMPLATES_URL, admin, {
        name:       'bienvenida_julio',
        category:   'UTILITY',
        components: [{ type: 'BODY', text: 'Bienvenido, {{1}}' }],
      }) as never
    )

    expect(res.status).toBe(201)
    expect((await res.json()).id).toBe(newId)
  })

  it('paso 2 — creación exitosa genera audit con action=create y resource=templates', async () => {
    const admin = makeAdminSession()
    const newId = 'dddddddd-2222-0000-0000-dddddddddddd'
    mockAdminCheck()
    mockInsert(newId)

    await templatesPost(
      adminPost(TEMPLATES_URL, admin, {
        name:       'promo_agosto',
        category:   'MARKETING',
        components: [{ type: 'BODY', text: 'Oferta especial' }],
      }) as never
    )

    expect(getAuditCall('create')).toMatchObject({
      action:      'create',
      resource:    'templates',
      resource_id: newId,
      metadata:    expect.objectContaining({ name: 'promo_agosto', category: 'MARKETING' }),
    })
  })

  it('paso 2 — creación con language explícito → se respeta en la inserción', async () => {
    const admin = makeAdminSession()
    const newId = 'dddddddd-3333-0000-0000-dddddddddddd'
    mockAdminCheck()
    mockInsert(newId)

    const res = await templatesPost(
      adminPost(TEMPLATES_URL, admin, {
        name:       'template_ingles',
        category:   'UTILITY',
        language:   'en',
        components: [{ type: 'BODY', text: 'Hello, {{1}}' }],
      }) as never
    )

    expect(res.status).toBe(201)
    expect((await res.json()).id).toBe(newId)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Test 2 — Template PATCH: actualización parcial → metadata.fields exacto
// ═══════════════════════════════════════════════════════════════════════════════

describe('Test 2 — Template PATCH: metadata.fields refleja exactamente los campos enviados', () => {

  /** Setup estándar: admin RBAC + UPDATE RETURNING id. */
  function mockPatchSuccess(): void {
    mockAdminCheck()
    vi.mocked(db.query).mockResolvedValueOnce([{ id: TEMPLATE_ID }] as never)
  }

  async function patch(body: Record<string, unknown>) {
    const admin = makeAdminSession()
    mockPatchSuccess()
    return templatesPatch(
      adminPatch(TEMPLATE_URL, admin, body) as never,
      TEMPLATE_PARAMS,
    )
  }

  it('enviar solo status → devuelve 200', async () => {
    const res = await patch({ status: 'APROBADA' })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it('enviar solo status → metadata.fields contiene únicamente "status"', async () => {
    await patch({ status: 'APROBADA' })

    const fields = getAuditCall('update')?.metadata?.fields as string[]
    expect(fields).toEqual(['status'])
  })

  it('enviar status + rejection_reason → metadata.fields contiene exactamente esos dos', async () => {
    await patch({ status: 'RECHAZADA', rejection_reason: 'Contenido no permitido' })

    const fields = getAuditCall('update')?.metadata?.fields as string[]
    expect(fields).toContain('status')
    expect(fields).toContain('rejection_reason')
    expect(fields).not.toContain('name')
    expect(fields).not.toContain('category')
    expect(fields).not.toContain('language')
    expect(fields).not.toContain('components')
  })

  it('enviar name + category → metadata.fields contiene exactamente esos dos', async () => {
    await patch({ name: 'nuevo_nombre', category: 'MARKETING' })

    const fields = getAuditCall('update')?.metadata?.fields as string[]
    expect(fields).toContain('name')
    expect(fields).toContain('category')
    expect(fields).not.toContain('status')
    expect(fields).not.toContain('rejection_reason')
  })

  it('status inválido → 400 Validation failed sin audit update', async () => {
    const admin = makeAdminSession()
    mockAdminCheck()

    const res  = await templatesPatch(
      adminPatch(TEMPLATE_URL, admin, { status: 'ESTADO_INEXISTENTE' }) as never,
      TEMPLATE_PARAMS,
    )

    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Validation failed')
    expect(getAuditCall('update')).toBeUndefined()
  })

  it('actualización exitosa genera audit con resource=templates y resource_id correcto', async () => {
    await patch({ status: 'EN_REVISION' })

    expect(getAuditCall('update')).toMatchObject({
      action:      'update',
      resource:    'templates',
      resource_id: TEMPLATE_ID,
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Test 3 — Automation POST: validación Zod + creación + audit
// ═══════════════════════════════════════════════════════════════════════════════

describe('Test 3 — Automation POST: validación Zod y creación exitosa con audit', () => {

  /** Payload base válido reutilizable en varias pruebas. */
  const BASE_AUTOMATION = {
    name:           'Respuesta automática',
    type:           'reply',
    trigger_type:   'keyword',
    trigger_config: { keyword: 'hola' },
    action_config:  { message: '¡Hola! En qué puedo ayudarte.' },
  }

  // ── Paso 1: validación de schema ──────────────────────────────────────────

  it('paso 1 — falta name → 400 con issue en campo "name"', async () => {
    const admin = makeAdminSession()
    mockAdminCheck()

    const res  = await automationsPost(
      adminPost(AUTOMATIONS_URL, admin, { type: 'reply', trigger_type: 'keyword' }) as never
    )
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Validation failed')
    expect(body.issues.some((i: { path: string }) => i.path === 'name')).toBe(true)
  })

  it('paso 1 — trigger_type inválido → 400 con issue en campo "trigger_type"', async () => {
    const admin = makeAdminSession()
    mockAdminCheck()

    const res  = await automationsPost(
      adminPost(AUTOMATIONS_URL, admin, {
        name:         'Auto test',
        type:         'reply',
        trigger_type: 'INVALIDO',
      }) as never
    )
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Validation failed')
    expect(body.issues.some((i: { path: string }) => i.path === 'trigger_type')).toBe(true)
  })

  it('paso 1 — type inválido → 400 con issue en campo "type"', async () => {
    const admin = makeAdminSession()
    mockAdminCheck()

    const res  = await automationsPost(
      adminPost(AUTOMATIONS_URL, admin, {
        name:         'Auto test',
        type:         'TIPO_INVALIDO',
        trigger_type: 'keyword',
      }) as never
    )
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.issues.some((i: { path: string }) => i.path === 'type')).toBe(true)
  })

  it('paso 1 — error de validación no genera audit create (solo validation_failed)', async () => {
    const admin = makeAdminSession()
    mockAdminCheck()

    await automationsPost(
      adminPost(AUTOMATIONS_URL, admin, { type: 'reply' }) as never
    )

    expect(getAuditCall('create')).toBeUndefined()
  })

  // ── Paso 2: creación exitosa ───────────────────────────────────────────────

  it('paso 2 — payload válido → 201 con el id de la nueva automation', async () => {
    const admin = makeAdminSession()
    const newId = 'aaaaaaaa-cccc-0000-0000-aaaaaaaaaaaa'
    mockAdminCheck()
    mockInsert(newId)

    const res = await automationsPost(
      adminPost(AUTOMATIONS_URL, admin, BASE_AUTOMATION) as never
    )

    expect(res.status).toBe(201)
    expect((await res.json()).id).toBe(newId)
  })

  it('paso 2 — creación genera audit con action=create y resource=automations', async () => {
    const admin = makeAdminSession()
    const newId = 'aaaaaaaa-dddd-0000-0000-aaaaaaaaaaaa'
    mockAdminCheck()
    mockInsert(newId)

    await automationsPost(
      adminPost(AUTOMATIONS_URL, admin, BASE_AUTOMATION) as never
    )

    expect(getAuditCall('create')).toMatchObject({
      action:      'create',
      resource:    'automations',
      resource_id: newId,
      metadata:    expect.objectContaining({
        name:        'Respuesta automática',
        type:        'reply',
        triggerType: 'keyword',
      }),
    })
  })

  it('paso 2 — campos opcionales (description, is_active, priority) → 201', async () => {
    const admin = makeAdminSession()
    const newId = 'aaaaaaaa-0005-0000-0000-aaaaaaaaaaaa'
    mockAdminCheck()
    mockInsert(newId)

    const res = await automationsPost(
      adminPost(AUTOMATIONS_URL, admin, {
        ...BASE_AUTOMATION,
        description: 'Responde saludos entrantes',
        is_active:   false,
        priority:    50,
      }) as never
    )

    expect(res.status).toBe(201)
    expect(getAuditCall('create')?.metadata?.name).toBe('Respuesta automática')
  })

  it.each(['reply', 'flow', 'handoff'] as const)(
    'paso 2 — tipo "%s" devuelve 201',
    async (type) => {
      const admin = makeAdminSession()
      mockAdminCheck()
      mockInsert('aaaaaaaa-0001-0000-0000-aaaaaaaaaaaa')

      const res = await automationsPost(
        adminPost(AUTOMATIONS_URL, admin, { ...BASE_AUTOMATION, type }) as never
      )

      expect(res.status).toBe(201)
    }
  )
})
