'use client'

import { useState, useEffect, useCallback } from 'react'
import { Loader2, Plus, Pencil, UserX, UserCheck, KeyRound, Search, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'

// ── Types ─────────────────────────────────────────────────────────────────────

type Role = 'admin' | 'operator' | 'viewer'

type User = {
  id: string
  email: string
  name: string | null
  role: Role
  sectors: string[]
  is_active: boolean
  last_login_at: string | null
  created_at: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ALL_SECTORS = [
  'dashboard', 'contacts', 'campaigns', 'conversations', 'lines', 'warmup', 'users', 'settings', 'lists', 'send',
] as const

const ROLE_LABELS: Record<Role, string> = {
  admin:    'Admin',
  operator: 'Operador',
  viewer:   'Viewer',
}

// ── Sub-components ────────────────────────────────────────────────────────────

function RoleBadge({ role }: { role: Role }) {
  if (role === 'admin') {
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold bg-orange-100 text-orange-700">
        Admin
      </span>
    )
  }
  if (role === 'operator') {
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold bg-blue-100 text-blue-700">
        Operador
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold bg-gray-100 text-gray-600">
      Viewer
    </span>
  )
}

function SectorPills({ sectors }: { sectors: string[] }) {
  if (!sectors || sectors.length === 0) {
    return <span className="text-xs text-gray-400">—</span>
  }
  return (
    <div className="flex flex-wrap gap-1">
      {sectors.map(s => (
        <Badge key={s} variant="outline" className="text-xs px-1.5 py-0 h-5">
          {s}
        </Badge>
      ))}
    </div>
  )
}

function formatDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  })
}

// ── Create/Edit User Modal ────────────────────────────────────────────────────

type UserFormData = {
  email: string
  name: string
  password: string
  role: Role
  sectors: string[]
}

function UserFormModal({
  open,
  onClose,
  onSave,
  initialData,
  mode,
}: {
  open: boolean
  onClose: () => void
  onSave: (data: UserFormData) => Promise<void>
  initialData?: Partial<UserFormData>
  mode: 'create' | 'edit'
}) {
  const [form, setForm] = useState<UserFormData>({
    email:    initialData?.email    ?? '',
    name:     initialData?.name     ?? '',
    password: '',
    role:     initialData?.role     ?? 'viewer',
    sectors:  initialData?.sectors  ?? [],
  })
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')

  useEffect(() => {
    if (open) {
      setForm({
        email:    initialData?.email    ?? '',
        name:     initialData?.name     ?? '',
        password: '',
        role:     initialData?.role     ?? 'viewer',
        sectors:  initialData?.sectors  ?? [],
      })
      setError('')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const toggleSector = (s: string) => {
    setForm(f => ({
      ...f,
      sectors: f.sectors.includes(s)
        ? f.sectors.filter(x => x !== s)
        : [...f.sectors, s],
    }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      await onSave(form)
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al guardar')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'Crear usuario' : 'Editar usuario'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-1">
          {mode === 'create' && (
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Email *</label>
              <Input
                type="email"
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                placeholder="usuario@empresa.com"
                required
              />
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Nombre</label>
            <Input
              type="text"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Nombre completo"
            />
          </div>

          {mode === 'create' && (
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">
                Contraseña * <span className="text-gray-400">(mín. 10 caracteres)</span>
              </label>
              <Input
                type="password"
                value={form.password}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                placeholder="••••••••••"
                required
                minLength={10}
              />
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Rol *</label>
            <select
              value={form.role}
              onChange={e => setForm(f => ({ ...f, role: e.target.value as Role }))}
              className="w-full h-8 rounded-lg border border-gray-200 px-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              required
            >
              <option value="admin">Admin</option>
              <option value="operator">Operador</option>
              <option value="viewer">Viewer</option>
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-gray-600 mb-2 block">Sectores</label>
            <div className="flex flex-wrap gap-2">
              {ALL_SECTORS.map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleSector(s)}
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium border transition-colors ${
                    form.sectors.includes(s)
                      ? 'bg-green-100 border-green-400 text-green-700'
                      : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {error && (
            <p className="text-xs text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
              Cancelar
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? <><Loader2 size={14} className="animate-spin mr-1" /> Guardando…</> : 'Guardar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── Reset Password Modal ──────────────────────────────────────────────────────

function ResetPasswordModal({
  open,
  userId,
  userName,
  onClose,
}: {
  open: boolean
  userId: string
  userName: string | null
  onClose: () => void
}) {
  const [password, setPassword] = useState('')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')
  const [success, setSuccess]   = useState(false)

  useEffect(() => {
    if (open) { setPassword(''); setError(''); setSuccess(false) }
  }, [open])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password.length < 10) {
      setError('La contraseña debe tener al menos 10 caracteres')
      return
    }
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/users/${userId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ password }),
      })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error || 'Error al cambiar contraseña')
      }
      setSuccess(true)
      setTimeout(onClose, 1200)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose() }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Cambiar contraseña — {userName || 'Usuario'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-1">
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">
              Nueva contraseña <span className="text-gray-400">(mín. 10 caracteres)</span>
            </label>
            <Input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••••"
              minLength={10}
              required
            />
          </div>
          {error   && <p className="text-xs text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>}
          {success && <p className="text-xs text-green-600 bg-green-50 border border-green-100 rounded-lg px-3 py-2">Contraseña actualizada</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={loading}>Cancelar</Button>
            <Button type="submit" disabled={loading || success}>
              {loading ? <><Loader2 size={14} className="animate-spin mr-1" /> Guardando…</> : 'Guardar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function UsersPage() {
  const [users, setUsers]         = useState<User[]>([])
  const [loading, setLoading]     = useState(true)
  const [search, setSearch]       = useState('')
  const [page, setPage]           = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [apiError, setApiError]   = useState('')

  // Modals
  const [createOpen, setCreateOpen]   = useState(false)
  const [editTarget, setEditTarget]   = useState<User | null>(null)
  const [resetTarget, setResetTarget] = useState<User | null>(null)

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    setApiError('')
    try {
      const params = new URLSearchParams({ page: String(page), limit: '50' })
      if (search) params.set('search', search)
      const res = await fetch(`/api/users?${params}`)
      if (!res.ok) throw new Error('Error al cargar usuarios')
      const data = await res.json()
      setUsers(data.users ?? [])
      setTotalPages(data.pagination?.pages ?? 1)
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : 'Error')
    } finally {
      setLoading(false)
    }
  }, [page, search])

  useEffect(() => { void fetchUsers() }, [fetchUsers])

  const handleCreate = async (form: UserFormData) => {
    const res = await fetch('/api/users', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(form),
    })
    if (!res.ok) {
      const d = await res.json()
      throw new Error(d.error || 'Error al crear usuario')
    }
    await fetchUsers()
  }

  const handleEdit = async (form: UserFormData) => {
    if (!editTarget) return
    const payload: Partial<UserFormData> & { is_active?: boolean } = {
      name:    form.name,
      role:    form.role,
      sectors: form.sectors,
    }
    const res = await fetch(`/api/users/${editTarget.id}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    })
    if (!res.ok) {
      const d = await res.json()
      throw new Error(d.error || 'Error al actualizar usuario')
    }
    await fetchUsers()
  }

  const handleToggleActive = async (user: User) => {
    const res = await fetch(`/api/users/${user.id}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ is_active: !user.is_active }),
    })
    if (!res.ok) {
      const d = await res.json()
      alert(d.error || 'Error al cambiar estado')
      return
    }
    await fetchUsers()
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-green-50 rounded-xl flex items-center justify-center">
            <Users size={18} className="text-green-600" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Usuarios</h1>
            <p className="text-xs text-gray-500">Gestión de usuarios y permisos (RBAC)</p>
          </div>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus size={14} className="mr-1" /> Nuevo usuario
        </Button>
      </div>

      {/* Search */}
      <div className="mb-4">
        <div className="relative max-w-xs">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            type="text"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            placeholder="Buscar por email o nombre…"
            className="pl-8"
          />
        </div>
      </div>

      {/* Error */}
      {apiError && (
        <p className="mb-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
          {apiError}
        </p>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-gray-400">
            <Loader2 size={20} className="animate-spin mr-2" />
            <span className="text-sm">Cargando usuarios…</span>
          </div>
        ) : users.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400">
            <Users size={32} className="mb-3 opacity-40" />
            <p className="text-sm font-medium">No hay usuarios</p>
            <p className="text-xs mt-1">Creá el primer usuario con el botón de arriba</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-gray-50">
                <TableHead>Nombre / Email</TableHead>
                <TableHead>Rol</TableHead>
                <TableHead>Sectores</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Último acceso</TableHead>
                <TableHead className="text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map(user => (
                <TableRow key={user.id}>
                  <TableCell>
                    <div>
                      <p className="text-sm font-medium text-gray-900">{user.name || '—'}</p>
                      <p className="text-xs text-gray-500">{user.email}</p>
                    </div>
                  </TableCell>
                  <TableCell>
                    <RoleBadge role={user.role} />
                  </TableCell>
                  <TableCell>
                    <SectorPills sectors={user.sectors} />
                  </TableCell>
                  <TableCell>
                    {user.is_active ? (
                      <span className="inline-flex items-center gap-1 text-xs text-green-700">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
                        Activo
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-gray-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-gray-300 inline-block" />
                        Inactivo
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-gray-500">{formatDate(user.last_login_at)}</span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {/* Edit */}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Editar"
                        onClick={() => setEditTarget(user)}
                      >
                        <Pencil size={13} />
                      </Button>
                      {/* Reset password */}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Cambiar contraseña"
                        onClick={() => setResetTarget(user)}
                      >
                        <KeyRound size={13} />
                      </Button>
                      {/* Toggle active */}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={user.is_active ? 'Desactivar' : 'Activar'}
                        onClick={() => handleToggleActive(user)}
                        className={user.is_active ? 'text-red-500 hover:bg-red-50' : 'text-green-600 hover:bg-green-50'}
                      >
                        {user.is_active ? <UserX size={13} /> : <UserCheck size={13} />}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-4">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
          >
            Anterior
          </Button>
          <span className="text-xs text-gray-500">Página {page} de {totalPages}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
          >
            Siguiente
          </Button>
        </div>
      )}

      {/* Create modal */}
      <UserFormModal
        open={createOpen}
        mode="create"
        onClose={() => setCreateOpen(false)}
        onSave={handleCreate}
      />

      {/* Edit modal */}
      <UserFormModal
        open={!!editTarget}
        mode="edit"
        onClose={() => setEditTarget(null)}
        onSave={handleEdit}
        initialData={editTarget ? { ...editTarget, name: editTarget.name ?? undefined } : undefined}
      />

      {/* Reset password modal */}
      <ResetPasswordModal
        open={!!resetTarget}
        userId={resetTarget?.id ?? ''}
        userName={resetTarget?.name ?? null}
        onClose={() => setResetTarget(null)}
      />
    </div>
  )
}
