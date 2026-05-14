/**
 * Shared helpers for security and integration tests.
 * Provides session factories, request builders, and test utilities used across all test files.
 */

import { vi }                  from 'vitest'
import { createSessionToken }  from '@/lib/auth'
import type { SessionUser }    from '@/lib/auth'

export const TEST_AUTH_SECRET = 'test-secret-for-security-integration'
export const TEST_IP          = '10.0.0.1'

// ── Session factories ─────────────────────────────────────────────────────────

export function makeSession(override: Partial<SessionUser> = {}): SessionUser {
  const now = Math.floor(Date.now() / 1000)
  return {
    user_id:               'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa',
    email:                 'test@example.com',
    name:                  'Test User',
    role:                  'viewer',
    sectors:               [],
    session_version:       1,
    can_download_contacts: true,
    allowed_agents:        [],
    iat:                   now,
    exp:                   now + 3600,
    nonce:                 'test-nonce',
    ...override,
  }
}

/** Shorthand for an admin session (bypasses all sector checks). */
export function makeAdminSession(override: Partial<SessionUser> = {}): SessionUser {
  return makeSession({ role: 'admin', sectors: [], ...override })
}

/** Shorthand for an operator session with the given sectors. */
export function makeOperatorSession(sectors: string[], override: Partial<SessionUser> = {}): SessionUser {
  return makeSession({ role: 'operator', sectors, ...override })
}

/** Shorthand for a viewer session with optional sectors. */
export function makeViewerSession(override: Partial<SessionUser> = {}): SessionUser {
  return makeSession({ role: 'viewer', ...override })
}

// ── Request builders ──────────────────────────────────────────────────────────

type ReqOptions = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> }

/**
 * Build a Request with a signed session cookie and a test IP.
 * Merges caller-supplied headers with the cookie and x-forwarded-for.
 */
export function makeReqWithSession(
  url:     string,
  session: SessionUser,
  options: ReqOptions = {},
): Request {
  const { headers = {}, ...rest } = options
  const token = createSessionToken(session)
  return new Request(url, {
    ...rest,
    headers: {
      ...headers,
      cookie:            `session=${token}`,
      'x-forwarded-for': TEST_IP,
    },
  })
}

/** Build a plain Request (no session) with the test IP pre-set. */
export function makeReq(url: string, options: ReqOptions = {}): Request {
  const { headers = {}, ...rest } = options
  return new Request(url, { ...rest, headers: { ...headers, 'x-forwarded-for': TEST_IP } })
}

// ── JSON request shortcuts ────────────────────────────────────────────────────

/** POST JSON with a session. */
export function adminPost(url: string, session: SessionUser, body: unknown): Request {
  return makeReqWithSession(url, session, {
    method:  'POST',
    body:    JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

/** PATCH JSON with a session. */
export function adminPatch(url: string, session: SessionUser, body: unknown): Request {
  return makeReqWithSession(url, session, {
    method:  'PATCH',
    body:    JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

/** DELETE request with a session. */
export function adminDelete(url: string, session: SessionUser): Request {
  return makeReqWithSession(url, session, { method: 'DELETE' })
}

// ── Stdout capture ────────────────────────────────────────────────────────────

/**
 * Run `fn` while intercepting all process.stdout.write calls.
 * Returns the function's result alongside all JSON lines written to stdout
 * during the call (parsed into objects). Non-JSON lines are silently ignored.
 *
 * The spy is always restored in a finally block — safe to use inside a test
 * even when `vi.resetAllMocks()` is called in beforeEach.
 */
export async function captureStdout<T>(
  fn: () => Promise<T> | T,
): Promise<{ result: T; events: Record<string, unknown>[] }> {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk))
    return true
  })
  try {
    const result = await fn()
    const events = chunks.flatMap(c => {
      try { return [JSON.parse(c.trim()) as Record<string, unknown>] } catch { return [] }
    })
    return { result, events }
  } finally {
    spy.mockRestore()
  }
}
