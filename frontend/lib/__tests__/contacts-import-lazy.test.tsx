import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'
vi.mock('@/lib/fetchJson', () => ({ fetchJson: vi.fn().mockResolvedValue({ contacts: [], total: 0, lists: [] }) }))
vi.mock('@/lib/useCurrentUser', () => ({ useCurrentUser: () => ({ user: { role: 'admin' }, permissions: { contacts: ['read', 'create'] } }) }))
import Contacts from '@/app/(protected)/contacts/page'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('still reads an Excel file after loading the parser on demand', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ total: 0, by_panel: {} }) })
  vi.stubGlobal('fetch', fetcher)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ telefono: '+5491111111111', nombre: 'Prueba' }]), 'Contactos')
  const file = new File([XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })], 'prueba.xlsx')
  const { container } = render(<Contacts />)
  const input = container.querySelector('input[type="file"]')!
  fireEvent.change(input, { target: { files: [file] } })
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/contacts/import/check', expect.objectContaining({ body: JSON.stringify({ phones: ['+5491111111111'] }) })))
})
