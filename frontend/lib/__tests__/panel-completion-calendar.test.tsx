// @vitest-environment happy-dom
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, it, expect, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('@/lib/fetchJson', () => ({ fetchJson: mocks.fetch }))
vi.mock('@/lib/useCurrentUser', () => ({ useCurrentUser: () => ({ user: null }) }))
import CalendarioPage from '@/app/(protected)/calendario/page'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks() })

it('renders the same calendar month in UTC and Argentina near midnight', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T01:45:00Z'))
  const original = process.env.TZ
  try {
    process.env.TZ = 'UTC'
    const server = renderToStaticMarkup(<CalendarioPage />)
    process.env.TZ = 'America/Argentina/Buenos_Aires'
    const browser = renderToStaticMarkup(<CalendarioPage />)
    expect(server).toBe(browser)
    expect(server).toContain('Septiembre')
    expect(server).not.toContain('Octubre')
  } finally {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  }
})

it('groups timestamped tasks on the Argentine day and loads another month after day navigation', async () => {
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/tasks/calendar')) return { tasks: [{
      id: 'fixture', title: 'Late task', type: 'otro', priority: 'media', status: 'pendiente',
      due_date: null, scheduled_at: '2026-10-01T01:45:00Z', assignees: [],
    }] }
    return url.startsWith('/api/marketing') ? { entries: [] } : { tasks: [] }
  })
  render(<CalendarioPage />)
  fireEvent.click(screen.getByRole('button', { name: 'Por día / hora' }))
  fireEvent.change(screen.getByLabelText('Fecha del calendario'), { target: { value: '2026-09-30' } })
  fireEvent.click(screen.getByRole('button', { name: 'Día siguiente' }))
  expect((screen.getByLabelText('Fecha del calendario') as HTMLInputElement).value).toBe('2026-10-01')
  await waitFor(() => expect(mocks.fetch.mock.calls.some(([url]) => {
    if (!url.startsWith('/api/tasks/calendar')) return false
    const params = new URL(url, 'http://localhost').searchParams
    return params.get('start') === '2026-09-27T00:00:00-03:00' && params.get('end') === '2026-11-07T23:59:59.999-03:00'
  })).toBe(true))
  fireEvent.change(screen.getByLabelText('Fecha del calendario'), { target: { value: '2026-09-30' } })
  fireEvent.click(screen.getByRole('button', { name: 'Mensual' }))
  await waitFor(() => expect(screen.getByText('▶ Late task')).toBeTruthy())
  expect(screen.getByText('▶ Late task').closest('button')?.textContent).toMatch(/^30/)
})
