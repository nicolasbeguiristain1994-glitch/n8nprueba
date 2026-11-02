vi.mock('@/lib/useCurrentUser',()=>({useCurrentUser:()=>({user:{role:'admin',id:'admin'},permissions:{users:['read','create']}})}))
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('next/navigation', () => ({useRouter: () => ({push:vi.fn()})}))
import UsersPage from '@/app/(protected)/users/page'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('creates a Royal operator with only conversations, statistics and calendar', async () => {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({users:[],pagination:{pages:1}}))
  vi.stubGlobal('fetch',fetch)
  render(<UsersPage />)
  await screen.findByText('No hay usuarios')
  fireEvent.click(screen.getByRole('button',{name:'Nuevo usuario'}))
  fireEvent.change(screen.getByLabelText('Aplicar perfil de agente'),{target:{value:'royal'}})
  fireEvent.change(screen.getByPlaceholderText('usuario@empresa.com'),{target:{value:'royal@example.com'}})
  fireEvent.change(screen.getByPlaceholderText('••••••••••'),{target:{value:'test-password'}})
  fireEvent.click(screen.getByRole('button',{name:'Guardar'}))
  await waitFor(() => expect(fetch.mock.calls.some(call => call[0] === '/api/users')).toBe(true))
  const call = fetch.mock.calls.find(call => call[0] === '/api/users')!
  expect(JSON.parse(call[1]!.body as string)).toMatchObject({role:'operator',allowed_agents:['royal'],sectors:['conversations','estadisticas','calendar'],can_download_contacts:false})
})
