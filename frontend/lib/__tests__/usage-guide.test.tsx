import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => ({ role: 'admin', permissions: {} as Record<string, string[]> }))
vi.mock('@/lib/useCurrentUser', () => ({ useCurrentUser: () => ({
  user: { role: session.role }, permissions: session.permissions, loading: false, error: null,
}) }))
vi.mock('next/link', () => ({ default: ({ prefetch: _prefetch, ...props }: React.ComponentProps<'a'> & { prefetch?: boolean }) => <a {...props} /> }))
import AyudaPage from '@/app/(protected)/ayuda/page'

beforeEach(() => {
  session.role = 'admin'
  session.permissions = {}
  window.history.replaceState({}, '', '/ayuda')
})
afterEach(cleanup)

describe('Usage guide navigation', () => {
  it('finds text inside examples, opens results and searches without accents', () => {
    render(<AyudaPage />)
    const search = screen.getByRole('searchbox', { name: 'Buscar en la guía' })
    fireEvent.change(search, { target: { value: 'martes 18:01' } })
    expect(screen.getByText('1 tema encontrado')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Efectividad de campañas/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/Si el envío fue el lunes/)).toBeVisible()
    fireEvent.change(search, { target: { value: 'segmentacion' } })
    expect(screen.getByRole('button', { name: /^Segmentación y movimientos/ })).toHaveAttribute('aria-expanded', 'true')
    fireEvent.change(search, { target: { value: 'tema inexistente xyz' } })
    expect(screen.getByText(/No encontramos temas/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Ver todos los temas' }))
    expect(search).toHaveValue('')
    expect(screen.getByRole('button', { name: /^Mis Tareas/ })).toBeInTheDocument()
  })

  it('limits sections and shortcuts to readable resources and explains viewer actions', () => {
    session.role = 'viewer'
    session.permissions = { contacts: ['read'] }
    render(<AyudaPage />)
    expect(screen.getByRole('button', { name: /^Contactos y listas/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Prioridades/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Usuarios y visibilidad/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Efectividad de campañas/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Medir la efectividad/ })).not.toBeInTheDocument()
    expect(screen.getByText(/Tu cuenta es de solo lectura/)).toBeVisible()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'cuenta WABA' } })
    expect(screen.queryByRole('button', { name: /^Plantillas/ })).not.toBeInTheDocument()
  })

  it('opens direct links and restores a collapsed section when its shortcut is used', () => {
    window.history.replaceState({}, '', '/ayuda#efectividad')
    render(<AyudaPage />)
    const effectiveness = screen.getByRole('button', { name: /^Efectividad de campañas/ })
    expect(effectiveness).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(effectiveness)
    expect(effectiveness).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByRole('link', { name: /Medir la efectividad/ }))
    expect(effectiveness).toHaveAttribute('aria-expanded', 'true')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'martes' } })
    window.history.replaceState({}, '', '/ayuda#lineas')
    fireEvent(window, new HashChangeEvent('hashchange'))
    expect(screen.getByRole('searchbox')).toHaveValue('')
    expect(screen.getByRole('button', { name: /^Líneas Conectar/ })).toHaveAttribute('aria-expanded', 'true')
  })

  it('supports opening and closing all results and choosing a topic on mobile', () => {
    render(<AyudaPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Expandir todo' }))
    expect(screen.getByRole('button', { name: /^Mis Tareas/ })).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Contraer todo' }))
    expect(screen.getByRole('button', { name: /^Mis Tareas/ })).toHaveAttribute('aria-expanded', 'false')
    fireEvent.change(screen.getByLabelText('Ir a un tema'), { target: { value: 'mis-tareas' } })
    expect(screen.getByRole('button', { name: /^Mis Tareas/ })).toHaveAttribute('aria-expanded', 'true')
    expect(window.location.hash).toBe('#mis-tareas')
    expect(screen.getByRole('link', { name: 'Abrir Mis Tareas' })).toHaveAttribute('href', '/mis-tareas')
  })
})
