'use client'
import { useState, useRef, useEffect } from 'react'
import { cn } from '@/lib/utils'

export interface EditableTextCellProps {
  value: string
  placeholder?: string
  className?: string
  onSave: (value: string) => void
}

/**
 * EditableTextCell — texto editable inline dentro de una celda de DataTable.
 *
 * Click → muestra un input. Enter/blur → guarda. Escape → cancela.
 */
export function EditableTextCell({
  value,
  placeholder = '—',
  className,
  onSave,
}: EditableTextCellProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft]     = useState(value)
  const inputRef              = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      setDraft(value)
      inputRef.current?.select()
    }
  }, [editing, value])

  const commit = () => {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed !== value) onSave(trimmed)
  }

  const cancel = () => {
    setEditing(false)
    setDraft(value)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        autoFocus
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter')  { e.preventDefault(); commit() }
          if (e.key === 'Escape') { e.preventDefault(); cancel() }
        }}
        onClick={e => e.stopPropagation()}
        className={cn(
          'text-sm w-full min-w-[120px] px-1 py-0 rounded',
          'border border-input bg-background',
          'focus:outline-none focus:ring-1 focus:ring-ring',
          className,
        )}
      />
    )
  }

  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); setEditing(true) }}
      title="Clic para editar"
      className={cn(
        'text-sm text-left w-full px-1 rounded',
        'hover:bg-muted/60 cursor-text transition-colors',
        !value && 'text-muted-foreground',
        className,
      )}
    >
      {value || placeholder}
    </button>
  )
}
