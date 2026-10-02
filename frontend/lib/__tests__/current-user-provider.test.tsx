import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CurrentUserProvider, useCurrentUser } from '../useCurrentUser'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const body = (id = 'alice') => ({ user: { id, name: id }, permissions: { contacts: ['read'] } })
const response = (id = 'alice') => ({ ok: true, json: async () => body(id) })
function Consumer({ label }: { label: string }) {
  const { user, permissions, loading, error } = useCurrentUser()
  return <output data-testid={label}>{loading ? 'loading' : error ?? `${user?.id}:${permissions.contacts?.join(',')}`}</output>
}
function App({ path = '/contacts', extra = false }: { path?: string; extra?: boolean }) {
  return <CurrentUserProvider refreshKey={path}>
    {['sidebar', 'mobile', 'menu', 'commands', 'page'].map(label => <Consumer key={label} label={label} />)}
    {extra && <Consumer label="new-page-part" />}
  </CurrentUserProvider>
}
it('shares one request across layout and page consumers, including consumers mounted later', async () => {
  const fetcher = vi.fn().mockResolvedValue(response()); vi.stubGlobal('fetch', fetcher)
  const { rerender } = render(<App />)
  await waitFor(() => expect(screen.getByTestId('page')).toHaveTextContent('alice:read'))
  expect(fetcher).toHaveBeenCalledTimes(1)
  rerender(<App extra />)
  await waitFor(() => expect(screen.getByTestId('new-page-part')).toHaveTextContent('alice:read'))
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('revalidates once on navigation and clears revoked permissions in every consumer', async () => {
  const fetcher = vi.fn().mockResolvedValue(response()); vi.stubGlobal('fetch', fetcher)
  const { rerender } = render(<App />)
  await waitFor(() => expect(screen.getByTestId('page')).toHaveTextContent('alice:read'))
  fetcher.mockResolvedValue({ ok: false, status: 401 })
  rerender(<App path="/campaigns" />)
  await waitFor(() => expect(screen.getByTestId('page')).toHaveTextContent('401'))
  expect(screen.getByTestId('sidebar')).toHaveTextContent('401')
  expect(fetcher).toHaveBeenCalledTimes(2)
})
it('does not reuse another login or accept a late request from an earlier navigation', async () => {
  let resolveOld!: (value: ReturnType<typeof response>) => void
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    .mockResolvedValue(response('bob'))
  vi.stubGlobal('fetch', fetcher)
  const { rerender, unmount } = render(<App />)
  rerender(<App path="/campaigns" />)
  await waitFor(() => expect(screen.getByTestId('page')).toHaveTextContent('bob:read'))
  await act(async () => resolveOld(response('alice')))
  expect(screen.getByTestId('page')).toHaveTextContent('bob:read')
  unmount()
  fetcher.mockResolvedValue(response('carol'))
  render(<App />)
  expect(screen.getByTestId('page')).toHaveTextContent('loading')
  await waitFor(() => expect(screen.getByTestId('page')).toHaveTextContent('carol:read'))
})
