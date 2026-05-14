// @vitest-environment node
/**
 * Tests de validación centralizada.
 * Cubre: parseBody(), handleValidationError() y los schemas más utilizados.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))

import {
  parseBody,
  handleValidationError,
  CreateTemplateSchema,
  UpdateAutomationSchema,
  UpdateUserSchema,
  PatchLineSchema,
  CloudSyncSchema,
  CreateWarmupSchema,
  UpdateSettingsSchema,
  CreateBlacklistSchema,
  LoginSchema,
} from '@/lib/schema'

function makeReq(url = 'http://localhost/api/test'): Request {
  return new Request(url, { method: 'POST' })
}

// ── parseBody() ───────────────────────────────────────────────────────────────

describe('parseBody()', () => {
  it('returns ok:true with parsed data on valid input', () => {
    const result = parseBody(LoginSchema, { email: 'user@test.com', password: 'secretpassword' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.email).toBe('user@test.com')
  })

  it('returns ok:false with ZodError on invalid input', () => {
    const result = parseBody(LoginSchema, { password: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.issues.length).toBeGreaterThan(0)
  })

  it('returns ok:false when data is null', () => {
    expect(parseBody(LoginSchema, null).ok).toBe(false)
  })

  it('returns ok:false when data is undefined', () => {
    expect(parseBody(LoginSchema, undefined).ok).toBe(false)
  })

  it('returns ok:false when data is a primitive instead of an object', () => {
    expect(parseBody(LoginSchema, 42).ok).toBe(false)
  })
})

// ── handleValidationError() ───────────────────────────────────────────────────

describe('handleValidationError()', () => {
  it('returns HTTP 400', async () => {
    const result = parseBody(LoginSchema, {})
    if (result.ok) throw new Error('Expected failure')
    const response = await handleValidationError(makeReq(), result.error, 'test')
    expect(response.status).toBe(400)
  })

  it('response body contains { error: "Validation failed", issues }', async () => {
    const result = parseBody(LoginSchema, { password: '' })
    if (result.ok) throw new Error('Expected failure')
    const response = await handleValidationError(makeReq(), result.error, 'test')
    const body = await response.json()
    expect(body.error).toBe('Validation failed')
    expect(Array.isArray(body.issues)).toBe(true)
    expect(body.issues.length).toBeGreaterThan(0)
  })

  it('each issue has path (string) and message (string)', async () => {
    const result = parseBody(LoginSchema, { password: '' })
    if (result.ok) throw new Error('Expected failure')
    const response = await handleValidationError(makeReq(), result.error, 'test')
    const body = await response.json()
    for (const issue of body.issues) {
      expect(typeof issue.path).toBe('string')
      expect(typeof issue.message).toBe('string')
    }
  })
})

// ── CreateTemplateSchema ──────────────────────────────────────────────────────

describe('CreateTemplateSchema', () => {
  it('parses valid input and applies defaults', () => {
    const result = parseBody(CreateTemplateSchema, { name: 'my_template', category: 'UTILITY' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.language).toBe('es')
      expect(result.data.components).toEqual([])
    }
  })

  it('rejects invalid category enum value', () => {
    const result = parseBody(CreateTemplateSchema, { name: 'x', category: 'INVALID' })
    expect(result.ok).toBe(false)
  })

  it('rejects missing name', () => {
    const result = parseBody(CreateTemplateSchema, { category: 'UTILITY' })
    expect(result.ok).toBe(false)
  })

  it('accepts explicit language override', () => {
    const result = parseBody(CreateTemplateSchema, { name: 'tmpl', category: 'MARKETING', language: 'pt_BR' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.language).toBe('pt_BR')
  })
})

// ── UpdateAutomationSchema ────────────────────────────────────────────────────

describe('UpdateAutomationSchema', () => {
  it('accepts empty object (all fields optional)', () => {
    expect(parseBody(UpdateAutomationSchema, {}).ok).toBe(true)
  })

  it('rejects invalid type enum', () => {
    expect(parseBody(UpdateAutomationSchema, { type: 'unknown' }).ok).toBe(false)
  })

  it('rejects priority out of range (> 1000)', () => {
    expect(parseBody(UpdateAutomationSchema, { priority: 5000 }).ok).toBe(false)
  })

  it('accepts valid partial update', () => {
    const result = parseBody(UpdateAutomationSchema, { is_active: false, priority: 50 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.is_active).toBe(false)
      expect(result.data.priority).toBe(50)
    }
  })
})

// ── PatchLineSchema ───────────────────────────────────────────────────────────

describe('PatchLineSchema', () => {
  it('rejects non-UUID id', () => {
    expect(parseBody(PatchLineSchema, { id: 'not-a-uuid' }).ok).toBe(false)
  })

  it('accepts valid patch with UUID id', () => {
    const result = parseBody(PatchLineSchema, {
      id: '00000000-0000-0000-0000-000000000000',
      sending_enabled: false,
    })
    expect(result.ok).toBe(true)
  })

  it('trims display_name and rejects blank string', () => {
    const result = parseBody(PatchLineSchema, {
      id: '00000000-0000-0000-0000-000000000000',
      display_name: '   ',
    })
    expect(result.ok).toBe(false)
  })
})

// ── CloudSyncSchema ───────────────────────────────────────────────────────────

describe('CloudSyncSchema', () => {
  it('rejects missing phoneNumberId', () => {
    expect(parseBody(CloudSyncSchema, {}).ok).toBe(false)
  })

  it('applies defaults for syncType and historyDays', () => {
    const result = parseBody(CloudSyncSchema, { phoneNumberId: '12345' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.syncType).toBe('history')
      expect(result.data.historyDays).toBe(180)
    }
  })

  it('rejects historyDays > 365', () => {
    expect(parseBody(CloudSyncSchema, { phoneNumberId: '1', historyDays: 400 }).ok).toBe(false)
  })

  it('accepts valid smb_app_state_sync type', () => {
    const result = parseBody(CloudSyncSchema, { phoneNumberId: '1', syncType: 'smb_app_state_sync' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.syncType).toBe('smb_app_state_sync')
  })
})

// ── CreateWarmupSchema ────────────────────────────────────────────────────────

describe('CreateWarmupSchema', () => {
  it('rejects phone_number not in E.164 format', () => {
    const result = parseBody(CreateWarmupSchema, { phone_number: '1234567890', instance_name: 'ok-name' })
    expect(result.ok).toBe(false)
  })

  it('rejects instance_name with spaces or special chars', () => {
    const result = parseBody(CreateWarmupSchema, { phone_number: '+5491112345678', instance_name: 'has spaces!' })
    expect(result.ok).toBe(false)
  })

  it('applies defaults for target_days, daily_limit, delay_preset', () => {
    const result = parseBody(CreateWarmupSchema, { phone_number: '+5491112345678', instance_name: 'instance-1' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.target_days).toBe(21)
      expect(result.data.daily_limit).toBe(10)
      expect(result.data.delay_preset).toBe('normal')
    }
  })

  it('accepts valid delay_preset override', () => {
    const result = parseBody(CreateWarmupSchema, {
      phone_number: '+5491112345678',
      instance_name: 'inst',
      delay_preset: 'conservadora',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.delay_preset).toBe('conservadora')
  })
})

// ── UpdateSettingsSchema ──────────────────────────────────────────────────────

describe('UpdateSettingsSchema', () => {
  it('rejects empty object', () => {
    expect(parseBody(UpdateSettingsSchema, {}).ok).toBe(false)
  })

  it('accepts object with at least one key', () => {
    const result = parseBody(UpdateSettingsSchema, { limits_max_warmup_lines: 30 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.limits_max_warmup_lines).toBe(30)
  })
})

// ── UpdateUserSchema.strict() ─────────────────────────────────────────────────

describe('UpdateUserSchema.strict()', () => {
  it('rejects an object with an unknown field (mass-assignment protection)', () => {
    const result = parseBody(UpdateUserSchema, { role: 'admin', is_god: true })
    expect(result.ok).toBe(false)
  })

  it('accepts a valid partial update with only allowed fields', () => {
    const result = parseBody(UpdateUserSchema, { role: 'operator', is_active: false })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.role).toBe('operator')
      expect(result.data.is_active).toBe(false)
    }
  })

  it('rejects an invalid role value', () => {
    const result = parseBody(UpdateUserSchema, { role: 'superadmin' })
    expect(result.ok).toBe(false)
  })
})

// ── CreateBlacklistSchema ─────────────────────────────────────────────────────

describe('CreateBlacklistSchema', () => {
  it('accepts a string of phone numbers', () => {
    const result = parseBody(CreateBlacklistSchema, { phones: '+5491112345678\n+5491187654321' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(typeof result.data.phones).toBe('string')
  })

  it('accepts an array of phone numbers', () => {
    const result = parseBody(CreateBlacklistSchema, { phones: ['+5491112345678'] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(Array.isArray(result.data.phones)).toBe(true)
  })

  it('rejects empty phones array', () => {
    expect(parseBody(CreateBlacklistSchema, { phones: [] }).ok).toBe(false)
  })

  it('rejects missing phones', () => {
    expect(parseBody(CreateBlacklistSchema, { reason: 'spam' }).ok).toBe(false)
  })
})
