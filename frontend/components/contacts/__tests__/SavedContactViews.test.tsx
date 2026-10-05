import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SavedContactViews, DEFAULT_CONTACT_VIEW, isContactView } from '../SavedContactViews'

beforeEach(() => localStorage.clear())
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const state = { ...DEFAULT_CONTACT_VIEW, segments: ['vip'], search: 'Ana', columns: { gaming: true, casino: false } }
describe('Personal contact views', () => {
  it('persists filters and columns, restores them after remount and isolates users', () => {
    const onApply = vi.fn()
    const { unmount } = render(<SavedContactViews userId="one" state={state} onApply={onApply} />)
    fireEvent.click(screen.getByRole('button', { name: 'Guardar vista' }))
    fireEvent.change(screen.getByLabelText('Nombre de la vista'), { target: { value: 'VIP Ana' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Guardar vista' }))
    unmount()
    const { rerender } = render(<SavedContactViews userId="one" state={DEFAULT_CONTACT_VIEW} onApply={onApply} />)
    const saved = JSON.parse(localStorage.getItem('crm:contact-views:one')!)[0]
    fireEvent.change(screen.getByLabelText('Vista de contactos'), { target: { value: saved.id } })
    expect(onApply).toHaveBeenLastCalledWith(state)
    rerender(<SavedContactViews userId="two" state={DEFAULT_CONTACT_VIEW} onApply={onApply} />)
    expect(screen.queryByRole('option', { name: 'VIP Ana' })).not.toBeInTheDocument()
  })
  it('rejects malformed state and reports unreadable storage', () => {
    expect(isContactView({ ...state, inactivity: { min: '', max: '', mode: 'invalid' } })).toBe(false)
    expect(isContactView({ ...state, columns: { name: 'yes' } })).toBe(false)
    localStorage.setItem('crm:contact-views:one', '{broken')
    render(<SavedContactViews userId="one" state={state} onApply={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('No se pudieron leer')
  })
  it('does not claim success when browser storage is unavailable', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Quota') })
    render(<SavedContactViews userId="one" state={state} onApply={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Guardar vista' }))
    fireEvent.change(screen.getByLabelText('Nombre de la vista'), { target: { value: 'VIP' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Guardar vista' }))
    expect(screen.getByRole('alert')).toHaveTextContent('No se pudo guardar')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
