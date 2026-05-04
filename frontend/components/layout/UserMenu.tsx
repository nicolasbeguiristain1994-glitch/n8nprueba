'use client'

/**
 * UserMenu — dropdown de usuario en el avatar de la Topbar.
 *
 * ┌──────────────────────────────┐
 * │ [nombre]         [rol badge] │
 * │ [email]                      │
 * ├──────────────────────────────┤
 * │ 👤  Mi perfil                │
 * │ ☀/🌙 Modo claro/oscuro       │
 * ├──────────────────────────────┤
 * │ ↩  Cerrar sesión             │
 * └──────────────────────────────┘
 *
 * Flujo de logout:
 *   1. Click "Cerrar sesión" → cierra dropdown, abre ConfirmDialog
 *   2. Confirm → estado loading → POST /api/auth/logout → router.push('/login')
 *   3. Cancel → cierra dialog sin efecto
 *
 * El ConfirmDialog usa el Dialog de @base-ui/react (componente ya en el proyecto).
 * No requiere librerías adicionales.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { LogOut, Sun, Moon, ChevronDown, User, Loader2 } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useRouter } from 'next/navigation'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

// ─────────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────────

function getUserInitials(name?: string | null, email?: string | null): string {
  if (name) {
    return name
      .split(' ')
      .filter(Boolean)
      .map(n => n[0])
      .join('')
      .slice(0, 2)
      .toUpperCase()
  }
  return email?.slice(0, 2).toUpperCase() ?? '··'
}

// ─────────────────────────────────────────────────────────────────────────────
// ConfirmLogoutDialog — aislado para separar responsabilidades
// ─────────────────────────────────────────────────────────────────────────────

interface ConfirmLogoutDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => Promise<void>
}

function ConfirmLogoutDialog({ open, onOpenChange, onConfirm }: ConfirmLogoutDialogProps) {
  const [loading, setLoading] = useState(false)

  // Reset loading si se cierra externamente
  useEffect(() => {
    if (!open) setLoading(false)
  }, [open])

  const handleConfirm = async () => {
    setLoading(true)
    try {
      await onConfirm()
      // onConfirm hace router.push → componente se desmonta, no necesitamos
      // setLoading(false) ni onOpenChange(false) — la redirección lo hace
    } catch {
      // Si el logout falla en red, igual redirigimos (sesión es stateless)
      setLoading(false)
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={loading ? undefined : onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Cerrar sesión</DialogTitle>
          <DialogDescription>
            ¿Estás seguro que querés cerrar tu sesión? Tendrás que volver a
            iniciar sesión para acceder a la plataforma.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cancelar
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={loading}
            className="min-w-[120px]"
          >
            {loading ? (
              <>
                <Loader2 size={14} className="mr-2 animate-spin" />
                Cerrando…
              </>
            ) : (
              <>
                <LogOut size={14} className="mr-2" />
                Cerrar sesión
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// MenuItem — ítem genérico del dropdown
// ─────────────────────────────────────────────────────────────────────────────

function MenuItem({
  onClick,
  icon: Icon,
  label,
  variant = 'default',
}: {
  onClick: () => void
  icon: React.ElementType
  label: string
  variant?: 'default' | 'destructive'
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors text-left',
        variant === 'destructive'
          ? 'text-destructive hover:bg-destructive/10'
          : 'text-foreground hover:bg-muted',
      )}
    >
      <Icon size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
      <span>{label}</span>
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// UserMenu principal
// ─────────────────────────────────────────────────────────────────────────────

export function UserMenu() {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  const { user } = useCurrentUser()
  const { resolvedTheme, setTheme } = useTheme()
  const router = useRouter()

  // ── Cerrar dropdown al hacer click fuera ──────────────────────────────────
  useEffect(() => {
    if (!dropdownOpen) return
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [dropdownOpen])

  // ── Cerrar dropdown con Escape ─────────────────────────────────────────────
  useEffect(() => {
    if (!dropdownOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDropdownOpen(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [dropdownOpen])

  // ── Acciones ──────────────────────────────────────────────────────────────

  const handleProfileClick = useCallback(() => {
    setDropdownOpen(false)
    router.push('/settings')
  }, [router])

  const handleThemeToggle = useCallback(() => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
  }, [resolvedTheme, setTheme])

  // Abre el dialog de confirmación (no hace logout directamente)
  const handleLogoutClick = useCallback(() => {
    setDropdownOpen(false)      // cierra el dropdown primero
    setConfirmOpen(true)        // luego abre el confirm
  }, [])

  // Lógica real del logout — llamada desde ConfirmLogoutDialog
  const executeLogout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } finally {
      // Siempre redirigir, aunque el endpoint falle (sesión stateless)
      router.push('/login')
    }
  }, [router])

  const initials = getUserInitials(user?.name, user?.email)
  const isDark = resolvedTheme === 'dark'

  return (
    <>
      <div ref={wrapperRef} className="relative">
        {/* ── Trigger: avatar + flecha ── */}
        <button
          onClick={() => setDropdownOpen(o => !o)}
          aria-haspopup="menu"
          aria-expanded={dropdownOpen}
          aria-label="Menú de usuario"
          suppressHydrationWarning
          className={cn(
            'flex items-center gap-1.5 rounded-full pl-0.5 pr-1.5 py-0.5',
            'transition-colors duration-150',
            'hover:bg-accent',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
            dropdownOpen && 'bg-accent',
          )}
        >
          <span
            suppressHydrationWarning
            className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-semibold select-none shrink-0"
          >
            {initials}
          </span>
          <ChevronDown
            size={11}
            className={cn(
              'text-muted-foreground transition-transform duration-150',
              dropdownOpen && 'rotate-180',
            )}
            aria-hidden="true"
          />
        </button>

        {/* ── Dropdown panel ── */}
        {dropdownOpen && (
          <div
            role="menu"
            aria-label="Opciones de usuario"
            className={cn(
              'absolute right-0 top-full mt-2 w-60 z-50',
              'rounded-xl border border-border bg-popover shadow-lg',
              'animate-in fade-in-0 zoom-in-95 duration-100 origin-top-right',
              'overflow-hidden',
            )}
          >
            {/* Info del usuario */}
            <div className="px-3 py-3 border-b border-border">
              <p className="text-sm font-semibold text-foreground truncate leading-none">
                {user?.name ?? 'Usuario'}
              </p>
              <p className="text-xs text-muted-foreground truncate mt-1">
                {user?.email ?? '—'}
              </p>
              {user?.role && (
                <span className="inline-block mt-2 text-[10px] font-medium bg-primary/10 text-primary rounded-full px-2 py-0.5 capitalize">
                  {user.role}
                </span>
              )}
            </div>

            {/* Acciones principales */}
            <div className="py-1">
              <MenuItem
                onClick={handleProfileClick}
                icon={User}
                label="Mi perfil"
              />
              <MenuItem
                onClick={handleThemeToggle}
                icon={isDark ? Sun : Moon}
                label={isDark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
              />
            </div>

            {/* Logout — separado visualmente */}
            <div className="border-t border-border py-1">
              <MenuItem
                onClick={handleLogoutClick}
                icon={LogOut}
                label="Cerrar sesión"
                variant="destructive"
              />
            </div>
          </div>
        )}
      </div>

      {/* Dialog de confirmación — fuera del div relativo para evitar z-index issues */}
      <ConfirmLogoutDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={executeLogout}
      />
    </>
  )
}
