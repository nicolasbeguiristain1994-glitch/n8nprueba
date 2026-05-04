/**
 * EditableCell — select inline editable dentro de una celda de DataTable.
 *
 * Reemplaza el patrón repetido de <select> nativo en las columnas de
 * Contactos (panel, línea, gaming, segment). Genera el mismo look:
 * texto coloreado como badge sin borde, cursor pointer.
 *
 * Uso en definición de columna:
 *   cell: ({ row }) => (
 *     <EditableCell
 *       value={row.original.panel || ''}
 *       options={[{ value: 'betcoin', label: 'betcoin' }, ...]}
 *       activeClass="bg-indigo-50 text-indigo-700"
 *       placeholder="— sin agente"
 *       onChange={v => updateField(row.original.id, 'panel', v || null)}
 *     />
 *   )
 */

import { cn } from '@/lib/utils'

export interface EditableCellOption {
  value: string
  label: string
}

export interface EditableCellProps {
  value: string
  options: EditableCellOption[]
  /**
   * Clases Tailwind que se aplican cuando `value` tiene contenido.
   * Ej: "bg-indigo-50 text-indigo-700"
   */
  activeClass?: string
  /** Texto de la opción vacía */
  placeholder?: string
  onChange: (value: string) => void
  className?: string
}

export function EditableCell({
  value,
  options,
  activeClass = 'bg-muted text-foreground',
  placeholder = '— sin asignar',
  onChange,
  className,
}: EditableCellProps) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      onClick={e => e.stopPropagation()}
      className={cn(
        'text-xs px-2 py-0.5 rounded-full font-medium',
        'border-0 cursor-pointer appearance-none bg-transparent',
        'focus:outline-none focus:ring-1 focus:ring-offset-0 focus:ring-border',
        value ? activeClass : 'text-muted-foreground',
        className,
      )}
    >
      <option value="">{placeholder}</option>
      {options.map(opt => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  )
}
