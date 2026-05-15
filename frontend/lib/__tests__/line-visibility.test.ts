// @vitest-environment node
/**
 * line-visibility.test.ts
 *
 * Tests for lib/line-visibility.ts and the SQL contract of get_accessible_line_ids().
 *
 * Architecture note:
 *   getAccessibleLineIds() is a thin TS wrapper over the SQL function
 *   get_accessible_line_ids(). We mock db.query to verify that:
 *     a) the right SQL is called with the right args
 *     b) the wrapper returns the expected shape for each role scenario
 *
 *   lineVisibilityClause() and distributorVisibilityClause() are pure functions
 *   (no DB) — tested directly.
 *
 *   canManageLineGrant() has its own DB mock tests.
 *
 * These tests document the EXPECTED BEHAVIOUR that the SQL function must implement.
 * After running the migration, run the integration suite against a real DB to
 * verify the SQL function itself (see tests/integration/line-visibility.sql.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/db', () => ({ query: vi.fn() }))

import * as db from '@/lib/db'
import {
  getAccessibleLineIds,
  lineVisibilityClause,
  distributorVisibilityClause,
  canManageLineGrant,
  type VisibilityActor,
} from '@/lib/line-visibility'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const LINE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const LINE_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const LINE_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

const SUPER_ADMIN: VisibilityActor = {
  user_id:       'superadmin-uuid',
  role:          'admin',
  is_super_admin: true,
}

const ADMIN: VisibilityActor = {
  user_id:       'admin-uuid',
  role:          'admin',
  is_super_admin: false,
}

const OPERATOR: VisibilityActor = {
  user_id:       'operator-uuid',
  role:          'operator',
  is_super_admin: false,
}

beforeEach(() => {
  vi.resetAllMocks()
})

// ── getAccessibleLineIds ──────────────────────────────────────────────────────

describe('getAccessibleLineIds — super_admin', () => {
  it('returns null immediately without touching the DB', async () => {
    const result = await getAccessibleLineIds(SUPER_ADMIN)

    expect(result).toBeNull()
    // super_admin shortcut: no DB round-trip, no IDs to fetch
    expect(vi.mocked(db.query)).not.toHaveBeenCalled()
  })
})

describe('getAccessibleLineIds — admin (non-super)', () => {
  it('calls get_accessible_line_ids() with the admin user_id', async () => {
    vi.mocked(db.query).mockResolvedValue([{ id: LINE_A }, { id: LINE_B }])

    const result = await getAccessibleLineIds(ADMIN)

    expect(vi.mocked(db.query)).toHaveBeenCalledWith(
      'SELECT id FROM get_accessible_line_ids($1)',
      ['admin-uuid'],
    )
    expect(result).toEqual([LINE_A, LINE_B])
  })

  it('returns an empty array when the admin has no accessible lines', async () => {
    // This can happen on a fresh install before any lines are created
    vi.mocked(db.query).mockResolvedValue([])

    const result = await getAccessibleLineIds(ADMIN)

    expect(result).toEqual([])
  })
})

describe('getAccessibleLineIds — operator', () => {
  it('calls get_accessible_line_ids() with the operator user_id', async () => {
    vi.mocked(db.query).mockResolvedValue([{ id: LINE_A }])

    const result = await getAccessibleLineIds(OPERATOR)

    expect(vi.mocked(db.query)).toHaveBeenCalledWith(
      'SELECT id FROM get_accessible_line_ids($1)',
      ['operator-uuid'],
    )
    expect(result).toEqual([LINE_A])
  })

  it('returns an empty array when the operator has no lines (new account)', async () => {
    vi.mocked(db.query).mockResolvedValue([])

    const result = await getAccessibleLineIds(OPERATOR)

    expect(result).toEqual([])
  })
})

// ── lineVisibilityClause ──────────────────────────────────────────────────────

describe('lineVisibilityClause — pure function', () => {
  it('returns empty clause and no params when ids is null (super_admin)', () => {
    const { clause, params } = lineVisibilityClause(null)
    expect(clause).toBe('')
    expect(params).toEqual([])
  })

  it('produces a correctly-parameterised AND fragment for a given array of IDs', () => {
    const ids = [LINE_A, LINE_B]
    const { clause, params } = lineVisibilityClause(ids, '', 1)

    expect(clause).toBe('AND id = ANY($1::uuid[])')
    expect(params).toEqual([ids])
  })

  it('applies the table alias correctly', () => {
    const { clause } = lineVisibilityClause([LINE_A], 'wl', 2)
    expect(clause).toBe('AND wl.id = ANY($2::uuid[])')
  })

  it('produces a valid (fail-closed) clause for an empty array', () => {
    // ANY('{}') never matches — correct fail-closed behaviour
    const { clause, params } = lineVisibilityClause([], '', 1)
    expect(clause).toBe('AND id = ANY($1::uuid[])')
    expect(params).toEqual([[]])
  })

  it('startAt shifts the bind parameter index', () => {
    const { clause } = lineVisibilityClause([LINE_A], 'l', 3)
    expect(clause).toBe('AND l.id = ANY($3::uuid[])')
  })
})

// ── distributorVisibilityClause ───────────────────────────────────────────────

describe('distributorVisibilityClause — pure function', () => {
  it('returns empty clause for null operatorId (system/bootstrap campaign)', () => {
    // When owned_by is null the distributor must use the full global pool
    const { clause, params } = distributorVisibilityClause(null)
    expect(clause).toBe('')
    expect(params).toEqual([])
  })

  it('returns empty clause for undefined operatorId', () => {
    const { clause, params } = distributorVisibilityClause(undefined)
    expect(clause).toBe('')
    expect(params).toEqual([])
  })

  it('injects the SQL function call when operatorId is provided', () => {
    const { clause, params } = distributorVisibilityClause('operator-uuid', 1)

    // Verify the filter is delegated inline to the SQL function (no pre-fetch)
    expect(clause).toBe('AND id = ANY(get_accessible_line_ids($1::uuid))')
    expect(params).toEqual(['operator-uuid'])
  })

  it('shifts the bind parameter index via startAt', () => {
    const { clause } = distributorVisibilityClause('operator-uuid', 2)
    expect(clause).toBe('AND id = ANY(get_accessible_line_ids($2::uuid))')
  })
})

// ── canManageLineGrant ────────────────────────────────────────────────────────

describe('canManageLineGrant — authorization gate', () => {
  // These tests mock the DB EXISTS result.
  // The SQL logic for what constitutes "allowed" is in the migration SQL;
  // here we verify the TypeScript wrapper correctly translates the DB response.

  it('returns true when DB returns allowed = true', async () => {
    vi.mocked(db.query).mockResolvedValue([{ allowed: true }])

    const result = await canManageLineGrant('actor-uuid', LINE_A)

    expect(result).toBe(true)
    expect(vi.mocked(db.query)).toHaveBeenCalledWith(
      expect.stringContaining('SELECT EXISTS'),
      ['actor-uuid', LINE_A],
    )
  })

  it('returns false when DB returns allowed = false', async () => {
    vi.mocked(db.query).mockResolvedValue([{ allowed: false }])

    const result = await canManageLineGrant('actor-uuid', LINE_A)

    expect(result).toBe(false)
  })

  it('returns false (fail-closed) when DB returns empty rows', async () => {
    // Should never happen with EXISTS, but guard against it
    vi.mocked(db.query).mockResolvedValue([])

    const result = await canManageLineGrant('actor-uuid', LINE_A)

    expect(result).toBe(false)
  })

  it('passes actorId as $1 and lineId as $2', async () => {
    vi.mocked(db.query).mockResolvedValue([{ allowed: true }])

    await canManageLineGrant('actor-id', 'line-id')

    expect(vi.mocked(db.query)).toHaveBeenCalledWith(
      expect.any(String),
      ['actor-id', 'line-id'],
    )
  })

  it('the SQL query checks all three authorisation branches', async () => {
    vi.mocked(db.query).mockResolvedValue([{ allowed: false }])

    await canManageLineGrant('actor-uuid', LINE_A)

    const sql = vi.mocked(db.query).mock.calls[0][0] as string
    // Branch 1: super_admin
    expect(sql).toContain('is_super_admin')
    // Branch 2: direct line owner
    expect(sql).toContain('owner_user_id')
    // Branch 3: manager of line owner
    expect(sql).toContain('manager_id')
    // NULL-owner guard: admin branch must not match legacy lines
    expect(sql).toContain('owner_user_id IS NOT NULL')
  })
})

// ── SQL contract documentation ────────────────────────────────────────────────
// The tests below document the behavioural contract of get_accessible_line_ids().
// They describe what the SQL function MUST return given specific data states.
// Run the integration suite (real DB) to verify these against the actual SQL.

describe('SQL contract — get_accessible_line_ids (documented behaviour)', () => {
  /**
   * super_admin: must see ALL lines, including NULL-owner legacy lines.
   * Verified above via the null shortcut (no DB call needed).
   */

  /**
   * admin (non-super):
   *   - own lines (owner_user_id = admin.id)
   *   - their operators' lines (users.manager_id = admin.id)
   *   - legacy/system lines (owner_user_id IS NULL)
   *   - lines explicitly granted to any of their operators
   *   - NOT lines owned by other admins
   */
  it('[contract] admin receives IDs from the SQL function covering own+operators+legacy', async () => {
    const expectedIds = [LINE_A, LINE_B, LINE_C]
    vi.mocked(db.query).mockResolvedValue(expectedIds.map(id => ({ id })))

    const result = await getAccessibleLineIds(ADMIN)

    expect(result).toHaveLength(3)
    expect(result).toEqual(expect.arrayContaining(expectedIds))
  })

  /**
   * operator/viewer:
   *   - own lines (owner_user_id = operator.id)
   *   - lines with an explicit grant (line_grants.granted_to = operator.id)
   *   - NOT NULL-owner legacy lines
   *   - NOT another operator's lines (even if same manager)
   */
  it('[contract] operator receives only their own lines + granted lines', async () => {
    // Only LINE_A owned by operator, LINE_B granted to them
    vi.mocked(db.query).mockResolvedValue([{ id: LINE_A }, { id: LINE_B }])

    const result = await getAccessibleLineIds(OPERATOR)

    expect(result).toEqual([LINE_A, LINE_B])
    // LINE_C (another operator's line with same manager) must not appear
    expect(result).not.toContain(LINE_C)
  })

  /**
   * Inactive user: the SQL function checks is_active = true.
   * An inactive user gets an empty set (fail-closed).
   */
  it('[contract] inactive user receives empty set (fail-closed)', async () => {
    vi.mocked(db.query).mockResolvedValue([])  // SQL function returns nothing

    const inactiveOperator: VisibilityActor = { ...OPERATOR, user_id: 'inactive-uuid' }
    const result = await getAccessibleLineIds(inactiveOperator)

    expect(result).toEqual([])
  })

  /**
   * Unknown user: if the user_id doesn't exist in the DB, the SQL function
   * returns an empty set (fail-closed — NOT FOUND → RETURN).
   */
  it('[contract] unknown user_id receives empty set (fail-closed)', async () => {
    vi.mocked(db.query).mockResolvedValue([])

    const unknownUser: VisibilityActor = { ...OPERATOR, user_id: 'nonexistent-uuid' }
    const result = await getAccessibleLineIds(unknownUser)

    expect(result).toEqual([])
  })
})
