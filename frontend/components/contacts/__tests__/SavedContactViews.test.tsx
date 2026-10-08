import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SavedContactViews, DEFAULT_CONTACT_VIEW, isContactView } from '../SavedContactViews'

beforeEach(() => localStorage.clear())
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const state = { ...DEFAULT_CONTACT_VIEW, segments: ['vip'], search: 'Ana', linea: ['2', '7'], columns: { gaming: true, casino: false } }
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
  it('restores a legacy single-line view and recognizes its normalized selection', () => {
    const legacy = { ...state, linea: '2', lineaSub: 'a' }
    localStorage.setItem('crm:contact-views:one', JSON.stringify([{ id: 'old', name: 'Línea anterior', state: legacy }]))
    const onApply = vi.fn()
    const { rerender } = render(<SavedContactViews userId="one" state={DEFAULT_CONTACT_VIEW} onApply={onApply} />)
    fireEvent.change(screen.getByLabelText('Vista de contactos'), { target: { value: 'old' } })
    expect(onApply).toHaveBeenLastCalledWith({ ...legacy, linea: ['2'] })
    rerender(<SavedContactViews userId="one" state={{ ...legacy, linea: ['2'] }} onApply={onApply} />)
    expect(screen.getByLabelText('Vista de contactos')).toHaveValue('old')
    expect(screen.getByRole('button', { name: 'Eliminar vista Línea anterior' })).toBeInTheDocument()
  })
  it('accepts legacy all-lines views and rejects malformed line arrays', () => {
    expect(isContactView({ ...state, linea: '' })).toBe(true)
    expect(isContactView({ ...state, linea: ['2', '7'] })).toBe(true)
    expect(isContactView({ ...state, linea: ['2', null] })).toBe(false)
    expect(isContactView({ ...state, linea: 2 })).toBe(false)
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
