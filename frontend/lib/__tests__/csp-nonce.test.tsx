// @vitest-environment node
/**
 * Propagación del nonce CSP (sin navegador).
 *
 * Covers:
 *  1. middleware: el header Content-Security-Policy del REQUEST (del que Next
 *     extrae el nonce para sus <script> inline) es idéntico al del response, y
 *     su nonce coincide con x-nonce.
 *  2. Las directivas de buildCsp no cambian: sin 'unsafe-eval' ni 'unsafe-inline'
 *     en script-src.
 *  3. Aislamiento por request: nonce nuevo en cada request; un CSP o x-nonce
 *     enviado por el cliente se pisa.
 *  4. Rutas protegidas con sesión y 401 de API siguen con la misma política.
 *  5. RootLayout pasa x-nonce a ThemeProvider y al <style>; el HTML SSR de
 *     next-themes emite su <script> inline con ese nonce.
 *
 * Entorno node: next-themes solo pone el nonce en el script cuando
 * `typeof window === 'undefined'` (render de servidor).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToString } from 'react-dom/server'
import { NextRequest } from 'next/server'
import { getScriptNonceFromHeader } from 'next/dist/server/app-render/get-script-nonce-from-header'

vi.mock('@/lib/auth', () => ({ getSessionFromRequest: vi.fn() }))
vi.mock('next/headers', () => ({ headers: vi.fn() }))

import * as auth from '@/lib/auth'
import { headers } from 'next/headers'
import { middleware } from '@/middleware'
import RootLayout from '@/app/layout'
import { ThemeProvider } from '@/components/layout/ThemeProvider'

// ── Helpers ───────────────────────────────────────────────────────────────────

const REQ_CSP   = 'x-middleware-request-content-security-policy'
const REQ_NONCE = 'x-middleware-request-x-nonce'

/** Política esperada: exactamente las directivas actuales de buildCsp. */
function expectedCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "connect-src 'self' wss: https:",
    "frame-src 'self' https://www.facebook.com https://web.facebook.com",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ')
}

function run(path: string, init: { headers?: Record<string, string> } = {}) {
  return middleware(new NextRequest(`http://localhost${path}`, init))
}

/** CSP del response, CSP del request (lo que ve el render) y x-nonce. */
function read(res: Response) {
  const responseCsp = res.headers.get('Content-Security-Policy') ?? ''
  const requestCsp  = res.headers.get(REQ_CSP)
  const xNonce      = res.headers.get(REQ_NONCE)
  const nonce       = getScriptNonceFromHeader(responseCsp)
  return { responseCsp, requestCsp, xNonce, nonce }
}

type AnyElement = { type: unknown; props: Record<string, unknown> & { children?: unknown } }

function findElement(node: unknown, match: (el: AnyElement) => boolean): AnyElement | null {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, match)
      if (found) return found
    }
    return null
  }
  const el = node as AnyElement
  if ('type' in el && 'props' in el) {
    if (match(el)) return el
    return findElement(el.props.children, match)
  }
  return null
}

beforeEach(() => {
  vi.resetAllMocks()
})

// ── Middleware ────────────────────────────────────────────────────────────────

describe('middleware — nonce en el request CSP', () => {
  it('pasa al render el MISMO Content-Security-Policy que envía al navegador, con el nonce de x-nonce', () => {
    const { responseCsp, requestCsp, xNonce, nonce } = read(run('/login'))

    expect(requestCsp).toBe(responseCsp)
    expect(nonce).toBeTruthy()
    // Lo que Next extrae del request CSP para sus <script> inline
    expect(getScriptNonceFromHeader(requestCsp ?? '')).toBe(nonce)
    expect(xNonce).toBe(nonce)
    // 16 bytes aleatorios en base64
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/)
  })

  it('mantiene exactamente las directivas actuales (sin unsafe-eval ni unsafe-inline en script-src)', () => {
    const { responseCsp, nonce } = read(run('/login'))

    expect(responseCsp).toBe(expectedCsp(nonce as string))
    expect(responseCsp).not.toMatch(/unsafe-eval/)
    const scriptSrc = responseCsp.split(';').map(d => d.trim()).find(d => d.startsWith('script-src'))
    expect(scriptSrc).toBe(`script-src 'self' 'nonce-${nonce}'`)
    expect(scriptSrc).not.toMatch(/unsafe-inline|strict-dynamic|\*/)
  })

  it('genera un nonce distinto por request y cada request lleva el suyo', () => {
    const a = read(run('/login'))
    const b = read(run('/login'))

    expect(a.nonce).not.toBe(b.nonce)
    expect(a.requestCsp).toBe(a.responseCsp)
    expect(b.requestCsp).toBe(b.responseCsp)
    expect(a.xNonce).toBe(a.nonce)
    expect(b.xNonce).toBe(b.nonce)
  })

  it('pisa un Content-Security-Policy o x-nonce enviado por el cliente', () => {
    const { requestCsp, xNonce, nonce } = read(run('/login', {
      headers: {
        'content-security-policy': "script-src * 'unsafe-inline' 'unsafe-eval'",
        'x-nonce':                 'nonce-del-atacante',
      },
    }))

    expect(requestCsp).toBe(expectedCsp(nonce as string))
    expect(xNonce).toBe(nonce)
    expect(xNonce).not.toBe('nonce-del-atacante')
  })

  it('aplica la misma propagación en rutas protegidas con sesión', () => {
    vi.mocked(auth.getSessionFromRequest).mockReturnValue({ user_id: 'u1', role: 'admin' } as never)
    const { responseCsp, requestCsp, xNonce, nonce } = read(run('/campaigns'))

    expect(responseCsp).toBe(expectedCsp(nonce as string))
    expect(requestCsp).toBe(responseCsp)
    expect(xNonce).toBe(nonce)
  })

  it('el 401 de API sin sesión conserva la misma política en el response', () => {
    vi.mocked(auth.getSessionFromRequest).mockReturnValue(null)
    const res = run('/api/campaigns')
    const { responseCsp, nonce } = read(res)

    expect(res.status).toBe(401)
    expect(responseCsp).toBe(expectedCsp(nonce as string))
  })
})

// ── Layout + next-themes ──────────────────────────────────────────────────────

describe('RootLayout — nonce a ThemeProvider', () => {
  const NONCE = 'AbCdEfGhIjKlMnOpQrStUv=='

  beforeEach(() => {
    vi.mocked(headers).mockResolvedValue(new Headers({ 'x-nonce': NONCE }) as never)
  })

  it('pasa x-nonce a ThemeProvider y al <style> inline', async () => {
    const tree = await RootLayout({ children: <main /> })

    const provider = findElement(tree, el => el.type === ThemeProvider)
    expect(provider?.props.nonce).toBe(NONCE)

    const style = findElement(tree, el => el.type === 'style')
    expect(style?.props.nonce).toBe(NONCE)
  })

  it('el HTML de servidor emite el <script> de next-themes con el nonce del request', async () => {
    const html = renderToString(await RootLayout({ children: <main /> }))

    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map(m => m[0])
    expect(scripts.length).toBeGreaterThan(0)
    // Todo <script> inline que emite el layout lleva el nonce: si faltara, el
    // navegador lo bloquearía con script-src nonce-only.
    for (const tag of scripts) {
      expect(tag).toContain(`nonce="${NONCE}"`)
    }
    expect(html).toMatch(new RegExp(`<style[^>]*nonce="${NONCE}"`))
  })
})
