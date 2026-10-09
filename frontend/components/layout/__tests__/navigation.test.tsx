import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileNav } from '../MobileNav'
import { Sidebar } from '../Sidebar'
import { SidebarContext } from '../sidebar-context'

const mocks = vi.hoisted(() => ({ user: { role: 'operator', sectors: ['contacts'], name: 'Operador', email: 'operator@example.test' } }))
vi.mock('next/navigation', () => ({ usePathname: () => '/contacts', useRouter: () => ({ push: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a> }))
vi.mock('@/lib/useCurrentUser', () => ({ useCurrentUser: () => ({ user: mocks.user }) }))
afterEach(() => { cleanup(); mocks.user.role = 'operator'; mocks.user.sectors = ['contacts'] })

describe('CRM navigation', () => {
  it('preserves assigned sectors on desktop and mobile, with a named active destination', () => {
    const { rerender } = render(<Sidebar />)
    const navigation = screen.getByRole('navigation', { name: 'Navegación principal' })
    expect(within(navigation).getByRole('link', { name: 'Contactos' })).toHaveAttribute('aria-current', 'page')
    expect(within(navigation).queryByRole('link', { name: 'Usuarios' })).not.toBeInTheDocument()
    expect(within(navigation).queryByRole('link', { name: 'Agentes' })).not.toBeInTheDocument()
    expect(within(navigation).queryByRole('link', { name: 'Campañas' })).not.toBeInTheDocument()
    rerender(<MobileNav />)
    expect(screen.getByRole('link', { name: 'Contactos' })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('link', { name: 'Campañas' })).not.toBeInTheDocument()
  })

  it('shows current administration destinations on desktop and mobile', () => {
    mocks.user.role = 'admin'
    const { rerender } = render(<Sidebar />)
    expect(screen.getByRole('link', { name: 'Usuarios' })).toHaveAttribute('href', '/users')
    expect(screen.getByRole('link', { name: 'Agentes' })).toHaveAttribute('href', '/agentes')
    expect(screen.getByRole('link', { name: 'Ajustes' })).toHaveAttribute('href', '/settings')
    expect(screen.queryByRole('link', { name: 'Monitoreo' })).not.toBeInTheDocument()
    rerender(<MobileNav />)
    expect(screen.queryByRole('link', { name: 'Monitoreo' })).not.toBeInTheDocument()
  })

  it('keeps icon-only destinations and the collapse control accessible', () => {
    const toggle = vi.fn()
    render(<SidebarContext.Provider value={{ collapsed: true, toggle, mobileOpen: false, setMobileOpen: vi.fn() }}><Sidebar /></SidebarContext.Provider>)
    expect(screen.getByRole('link', { name: 'Contactos' })).toHaveAttribute('href', '/contacts')
    fireEvent.click(screen.getByRole('button', { name: 'Expandir sidebar' }))
    expect(toggle).toHaveBeenCalledOnce()
  })
})
