# DataTable

Sistema de tabla reusable basado en **TanStack Table v8** + **@tanstack/react-virtual**.
Diseñado para cualquier entidad del CRM (Contactos, Campañas, Usuarios, etc.).

## Características

- Sorting (click en header de columna)
- Paginación client-side o **server-side** (manual)
- Row selection + bulk actions flotante
- Density toggle (Compacto / Normal / Cómodo) — **persiste en localStorage**
- Column visibility toggle — **persiste en localStorage**
- Hover actions por fila
- Responsive: tabla en desktop, **cards en mobile** (< 768px)
- Virtualización para 5000+ filas (`virtual={true}`)
- Loading skeleton + empty state reutilizables

---

## Uso básico

```tsx
import { DataTable, DataTableColumnHeader } from '@/components/data-display/DataTable'
import type { ColumnDef } from '@/components/data-display/DataTable'

const columns = useMemo<ColumnDef<User, unknown>[]>(() => [
  {
    id: 'name',
    accessorKey: 'name',
    header: ({ column }) => <DataTableColumnHeader column={column} title="Nombre" />,
    meta: { mobileLabel: 'Nombre' },
  },
  {
    id: 'email',
    accessorKey: 'email',
    header: 'Email',
    meta: { mobileLabel: 'Email' },
  },
], [])

<DataTable data={users} columns={columns} loading={loading} storageKey="users" />
```

---

## Con persistencia + server-side pagination

```tsx
const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 50 })
const [rowSelection, setRowSelection] = useState({})

<DataTable
  data={contacts}
  columns={columns}
  loading={loading}
  storageKey="contacts"          // clave para localStorage (density + cols)
  getRowId={(row) => row.id}
  rowSelection={rowSelection}
  onRowSelectionChange={setRowSelection}
  manualPagination                    // ← activa modo server-side
  pageCount={Math.ceil(total / 50)}
  pagination={pagination}
  onPaginationChange={setPagination}
  totalRows={total}
  bulkActions={(ids) => (
    <DataTableBulkActions selectedCount={ids.length} onClearSelection={() => setRowSelection({})}>
      <Button onClick={() => deleteMany(ids)}>Eliminar</Button>
    </DataTableBulkActions>
  )}
/>
```

Cuando `pagination.pageIndex` cambia, hacer el fetch con `page: pageIndex + 1`.

---

## Con virtualización (5000+ filas client-side)

```tsx
<DataTable
  data={allRows}     // array completo en memoria
  columns={columns}
  storageKey="big-list"
  virtual            // ← activa react-virtual, elimina paginación
/>
```

> **Nota:** `virtual` y `manualPagination` son mutuamente excluyentes.

---

## API principal

| Prop | Tipo | Descripción |
|------|------|-------------|
| `data` | `TData[]` | Filas actuales |
| `columns` | `ColumnDef<TData>[]` | Definición de columnas |
| `loading` | `boolean` | Muestra skeleton |
| `storageKey` | `string` | Prefijo localStorage (`"contacts"` → `contacts:density`) |
| `manualPagination` | `boolean` | Paginación controlada externamente |
| `pageCount` | `number` | Total de páginas (requerido con `manualPagination`) |
| `pagination` | `PaginationState` | `{ pageIndex, pageSize }` |
| `onPaginationChange` | `(p) => void` | Callback de cambio de página |
| `rowSelection` | `RowSelectionState` | Estado de selección controlado |
| `onRowSelectionChange` | `(s) => void` | Callback de selección |
| `getRowId` | `(row) => string` | ID único de cada fila |
| `bulkActions` | `(ids: string[]) => ReactNode` | Barra flotante de acciones bulk |
| `emptyState` | `ReactNode` | Estado vacío custom |
| `virtual` | `boolean` | Activar virtualización |

---

## EditableCell

Para celdas con select inline (ej: asignar agente/nivel/línea), usar `EditableCell`:

```tsx
import { EditableCell } from '@/components/data-display/DataTable'

cell: ({ row }) => (
  <EditableCell
    value={row.original.panel || ''}
    options={PANEL_OPTIONS.map(p => ({ value: p, label: p }))}
    activeClass="bg-indigo-50 text-indigo-700"
    placeholder="— sin agente"
    onChange={v => updateField(row.original.id, 'panel', v || null)}
  />
)
```
