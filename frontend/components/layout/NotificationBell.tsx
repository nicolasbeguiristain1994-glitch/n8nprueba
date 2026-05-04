'use client'

import { useRef, useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  Bell, CheckCheck, ClipboardList, MessageSquare,
  Megaphone, AlertTriangle, Info, X,
} from 'lucide-react'
import { useNotifications, type Notification } from '@/lib/useNotifications'
import { cn } from '@/lib/utils'

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins  = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days  = Math.floor(diff / 86_400_000)

  if (mins  < 1)   return 'Justo ahora'
  if (mins  < 60)  return `Hace ${mins} min`
  if (hours < 24)  return `Hace ${hours} h`
  if (days  < 7)   return `Hace ${days} días`
  return new Date(dateStr).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })
}

const TYPE_META: Record<string, { icon: React.ElementType; color: string; label: string }> = {
  tarea_asignada:    { icon: ClipboardList,  color: 'text-blue-500',   label: 'Tarea' },
  tarea_estado:      { icon: ClipboardList,  color: 'text-indigo-500', label: 'Tarea' },
  mensaje_nuevo:     { icon: MessageSquare,  color: 'text-green-500',  label: 'Mensaje' },
  campana_finalizada:{ icon: Megaphone,      color: 'text-orange-500', label: 'Campaña' },
  alerta_operativa:  { icon: AlertTriangle,  color: 'text-red-500',    label: 'Alerta' },
}

// ── Item individual ───────────────────────────────────────────────────────────

function NotifItem({
  notif,
  onRead,
  onNavigate,
}: {
  notif: Notification
  onRead: (id: string) => void
  onNavigate: () => void
}) {
  const router  = useRouter()
  const meta    = TYPE_META[notif.type] ?? { icon: Info, color: 'text-gray-400', label: 'Sistema' }
  const Icon    = meta.icon

  function handleClick() {
    if (!notif.is_read) onRead(notif.id)
    if (notif.link) {
      router.push(notif.link)
      onNavigate()
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={e => e.key === 'Enter' && handleClick()}
      className={cn(
        'flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors group',
        'hover:bg-accent/50',
        !notif.is_read && 'bg-blue-50/60 dark:bg-blue-950/20',
      )}
    >
      {/* Ícono del tipo */}
      <div className={cn('mt-0.5 shrink-0', meta.color)}>
        <Icon size={16} />
      </div>

      {/* Contenido */}
      <div className="flex-1 min-w-0">
        <p className={cn(
          'text-sm leading-snug truncate',
          !notif.is_read ? 'font-semibold text-foreground' : 'font-medium text-foreground/80'
        )}>
          {notif.title}
        </p>
        {notif.body && (
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2 leading-relaxed">
            {notif.body}
          </p>
        )}
        <p className="text-[11px] text-muted-foreground/60 mt-1">
          {relativeTime(notif.created_at)}
        </p>
      </div>

      {/* Punto de no leída */}
      {!notif.is_read && (
        <span
          className="mt-1.5 shrink-0 w-2 h-2 rounded-full bg-blue-500"
          aria-label="No leída"
        />
      )}
    </div>
  )
}

// ── Panel de preferencias (inline dentro del dropdown) ────────────────────────

function PreferencesPanel({ onClose }: { onClose: () => void }) {
  type Prefs = {
    notify_tarea_asignada: boolean
    notify_tarea_estado: boolean
    notify_mensaje_nuevo: boolean
    notify_campana: boolean
    notify_alerta_operativa: boolean
  }

  const [prefs, setPrefs] = useState<Prefs | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch('/api/notifications/preferences')
      .then(r => r.json())
      .then(setPrefs)
      .catch(() => {})
  }, [])

  async function toggle(key: keyof Prefs) {
    if (!prefs) return
    const next = { ...prefs, [key]: !prefs[key] }
    setPrefs(next)
    setSaving(true)
    try {
      await fetch('/api/notifications/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: next[key] }),
      })
    } finally {
      setSaving(false)
    }
  }

  const ITEMS: { key: keyof Prefs; label: string }[] = [
    { key: 'notify_tarea_asignada',   label: 'Tarea asignada' },
    { key: 'notify_tarea_estado',     label: 'Cambios de estado en tareas' },
    { key: 'notify_mensaje_nuevo',    label: 'Mensajes nuevos' },
    { key: 'notify_campana',          label: 'Campañas finalizadas' },
    { key: 'notify_alerta_operativa', label: 'Alertas operativas' },
  ]

  return (
    <div className="px-4 pb-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-semibold text-foreground">Preferencias</p>
        <button onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
          ← Volver
        </button>
      </div>

      {!prefs ? (
        <p className="text-xs text-muted-foreground">Cargando…</p>
      ) : (
        <div className="space-y-2.5">
          {ITEMS.map(({ key, label }) => (
            <label key={key} className="flex items-center justify-between gap-3 cursor-pointer group">
              <span className="text-xs text-foreground/80 group-hover:text-foreground transition-colors">
                {label}
              </span>
              {/* Toggle switch */}
              <button
                role="switch"
                aria-checked={prefs[key]}
                onClick={() => toggle(key)}
                disabled={saving}
                className={cn(
                  'relative w-8 h-4 rounded-full transition-colors shrink-0',
                  prefs[key] ? 'bg-blue-500' : 'bg-muted-foreground/30'
                )}
              >
                <span className={cn(
                  'absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform',
                  prefs[key] && 'translate-x-4'
                )} />
              </button>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Componente principal: NotificationBell ───────────────────────────────────

export function NotificationBell() {
  const { notifications, unread, loading, error, markRead, markAllRead, refresh } = useNotifications()
  const [open, setOpen] = useState(false)
  const [showPrefs, setShowPrefs] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const btnRef   = useRef<HTMLButtonElement>(null)

  // Cerrar al hacer click fuera
  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent) {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        btnRef.current   && !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
        setShowPrefs(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  // Cerrar con Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setOpen(false); setShowPrefs(false) }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [])

  // Al abrir: refresh
  function handleToggle() {
    if (!open) { refresh(); setShowPrefs(false) }
    setOpen(o => !o)
  }

  const badgeCount = Math.min(unread, 99)

  return (
    <div className="relative">
      {/* Campanita */}
      <button
        ref={btnRef}
        onClick={handleToggle}
        className={cn(
          'flex items-center justify-center w-8 h-8 rounded-md',
          'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
          'transition-colors relative',
          open && 'bg-accent text-accent-foreground',
        )}
        aria-label="Notificaciones"
        aria-expanded={open}
      >
        <Bell size={16} />
        {unread > 0 && (
          <span className="absolute top-1 right-1 flex items-center justify-center min-w-[14px] h-[14px] rounded-full bg-red-500 text-white text-[9px] font-bold leading-none px-0.5 shadow">
            {badgeCount > 99 ? '99+' : badgeCount}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div
          ref={panelRef}
          className={cn(
            'absolute right-0 top-full mt-2 w-80 z-50',
            'bg-background border border-border rounded-xl shadow-xl',
            'overflow-hidden',
          )}
        >
          {showPrefs ? (
            <>
              <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
                <Bell size={14} className="text-muted-foreground" />
                <span className="text-sm font-semibold flex-1">Notificaciones</span>
              </div>
              <div className="pt-3">
                <PreferencesPanel onClose={() => setShowPrefs(false)} />
              </div>
            </>
          ) : (
            <>
              {/* Header */}
              <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
                <Bell size={14} className="text-muted-foreground" />
                <span className="text-sm font-semibold flex-1">
                  Notificaciones
                  {unread > 0 && (
                    <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-red-500 text-white text-[10px] font-bold px-1">
                      {badgeCount}
                    </span>
                  )}
                </span>
                {unread > 0 && (
                  <button
                    onClick={markAllRead}
                    className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                    title="Marcar todas como leídas"
                  >
                    <CheckCheck size={13} />
                    <span>Leer todas</span>
                  </button>
                )}
                <button
                  onClick={() => setShowPrefs(true)}
                  className="text-[11px] text-muted-foreground hover:text-foreground transition-colors ml-1"
                  title="Preferencias"
                >
                  ⚙
                </button>
              </div>

              {/* Lista */}
              <div className="max-h-[380px] overflow-y-auto overscroll-contain divide-y divide-border/50">
                {loading && (
                  <div className="flex flex-col gap-2 px-4 py-4">
                    {[1, 2, 3].map(i => (
                      <div key={i} className="flex items-start gap-3 animate-pulse">
                        <div className="w-4 h-4 rounded-full bg-muted mt-0.5 shrink-0" />
                        <div className="flex-1 space-y-1.5">
                          <div className="h-3 bg-muted rounded w-3/4" />
                          <div className="h-2.5 bg-muted rounded w-1/2" />
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {!loading && error && (
                  <div className="flex flex-col items-center gap-2 py-8 text-center px-4">
                    <AlertTriangle size={20} className="text-red-400" />
                    <p className="text-xs text-muted-foreground">
                      No se pudieron cargar las notificaciones
                    </p>
                    <button
                      onClick={refresh}
                      className="text-xs text-blue-500 hover:underline"
                    >
                      Reintentar
                    </button>
                  </div>
                )}

                {!loading && !error && notifications.length === 0 && (
                  <div className="flex flex-col items-center gap-2 py-10 text-center px-4">
                    <Bell size={24} className="text-muted-foreground/30" />
                    <p className="text-sm text-muted-foreground">No tenés notificaciones</p>
                    <p className="text-xs text-muted-foreground/60">
                      Cuando haya actividad te avisamos acá
                    </p>
                  </div>
                )}

                {!loading && !error && notifications.map(n => (
                  <NotifItem
                    key={n.id}
                    notif={n}
                    onRead={id => markRead([id])}
                    onNavigate={() => { setOpen(false); setShowPrefs(false) }}
                  />
                ))}
              </div>

              {/* Footer */}
              {notifications.length > 0 && (
                <div className="px-4 py-2.5 border-t border-border text-center">
                  <button
                    onClick={() => { setOpen(false); setShowPrefs(false) }}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Cerrar
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
