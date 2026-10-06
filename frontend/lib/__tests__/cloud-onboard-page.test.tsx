import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import Page from '@/app/(protected)/lines/cloud-onboard/page'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('selects an independent app, clears previous credentials and submits its own asset IDs', async () => {
  const apps = [
    { appId:'12345', name:'Principal', wabaIds:[], webhookPath:'/api/cloud/webhook', checks:{ appSecret:false } },
    { appId:'98765', name:'Nexus', wabaIds:['87654'], webhookPath:'/api/cloud/webhook/98765', checks:{ appSecret:true } },
  ]
  const fetchMock = vi.fn(async (url:string) => new Response(JSON.stringify(url === '/api/cloud/config' ? { ...apps[0], apps } : { displayPhone:'+5491100000000', message:'Conectado' })))
  vi.stubGlobal('fetch', fetchMock)
  render(<Page />)
  const select = await screen.findByRole('combobox', { name:'Aplicación Meta' })
  expect(screen.getByRole('button', { name:'Validar y conectar número' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Token de usuario de sistema'), { target:{ value:'old-token' } })
  fireEvent.change(select, { target:{ value:'98765' } })
  expect(screen.getByLabelText('Token de usuario de sistema')).toHaveValue('')
  expect(screen.getByLabelText('App ID')).toHaveValue('98765')
  expect(screen.getByLabelText('App ID')).toHaveAttribute('readonly')
  expect(screen.getByLabelText('WABA ID')).toHaveValue('87654')
  expect(screen.getByText(/\/api\/cloud\/webhook\/98765/)).toBeInTheDocument()
  const button = screen.getByRole('button', { name:'Validar y conectar número' })
  expect(button).toBeEnabled()
  fireEvent.change(screen.getByLabelText('Phone Number ID'), { target:{ value:'76543' } })
  fireEvent.change(screen.getByLabelText('Token de usuario de sistema'), { target:{ value:'new-test-token' } })
  fireEvent.click(button)
  await screen.findByRole('status')
  const call = fetchMock.mock.calls.find(([url]) => url === '/api/cloud/connect') as unknown as [string, RequestInit]
  expect(JSON.parse(call[1].body as string)).toMatchObject({ appId:'98765', wabaId:'87654', phoneNumberId:'76543', accessToken:'new-test-token', register:false })
  expect(screen.getByLabelText('Token de usuario de sistema')).toHaveValue('')
})
