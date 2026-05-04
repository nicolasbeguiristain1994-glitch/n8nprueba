# Kanban Pipeline

Tablero Kanban con Drag & Drop para gestión de deals comerciales. Construido sobre **@dnd-kit** (sin React DnD ni sortable-js), con optimistic updates y soporte mobile con vista de tabs por stage.

---

## Estructura de archivos

```
components/kanban/
├── types.ts              — Deal, DealStage, DealsByStage, KANBAN_COLUMNS
├── useKanban.ts          — Hook central: estado de deals + handlers de DnD + CRUD
├── KanbanBoard.tsx       — DndContext wrapper, layout desktop/mobile, DragOverlay
├── KanbanColumn.tsx      — Columna droppable con SortableContext y header stats
├── KanbanCard.tsx        — Card sortable memoizada con drag handle y acciones hover
├── KanbanDealForm.tsx    — Modal crear/editar deal (POST o PATCH)
├── KanbanBoardHeader.tsx — Header de página (título + descripción)
├── KanbanSkeleton.tsx    — Placeholder animado mientras cargan los datos
└── __tests__/
    └── kanban.test.tsx   — Tests de renderizado, hooks y UI (vitest)
```

---

## Uso básico

```tsx
// app/(protected)/pipeline/page.tsx  (Server Component)
import { KanbanBoard } from '@/components/kanban/KanbanBoard'
import { KanbanSkeleton } from '@/components/kanban/KanbanSkeleton'

// initialDeals viene del API, agrupado por stage
export default async function PipelinePage() {
  const initialDeals = await fetchDeals()

  return (
    <div className="flex flex-col h-full">
      <KanbanBoardHeader />
      <div className="flex-1 overflow-x-auto px-4 pb-4 pt-2">
        <KanbanBoard initialDeals={initialDeals} />
      </div>
    </div>
  )
}
```

El archivo `loading.tsx` al lado de `page.tsx` se activa automáticamente con Next.js App Router mientras `fetchDeals` resuelve:

```tsx
// app/(protected)/pipeline/loading.tsx
export default function PipelineLoading() {
  return <KanbanSkeleton cardsPerColumn={3} />
}
```

---

## Agregar un nuevo stage

1. **`types.ts`** — extender el union type y el array de columnas:

```ts
export type DealStage =
  | 'calificado' | 'propuesta' | 'negociacion'
  | 'cierre' | 'ganado' | 'perdido'
  | 'en_revision'   // ← nuevo

export const KANBAN_COLUMNS: KanbanColumnConfig[] = [
  // ... columnas existentes ...
  { id: 'en_revision', label: 'En revisión', color: 'bg-cyan-400', headerClass: 'border-t-cyan-400' },
]
```

2. **`db/migrations/`** — modificar el CHECK constraint del campo `stage`:

```sql
ALTER TABLE deals DROP CONSTRAINT deals_stage_check;
ALTER TABLE deals ADD CONSTRAINT deals_stage_check
  CHECK (stage IN ('calificado','propuesta','negociacion','cierre','ganado','perdido','en_revision'));
```

3. **`/api/deals/route.ts`** — agregar `'en_revision'` al array `STAGES`.

No hay más cambios necesarios: el board, la columna y el formulario leen `KANBAN_COLUMNS` dinámicamente.

---

## Notas técnicas

### Optimistic updates

El flujo de un drag & drop es:
1. **`handleDragOver`** — mueve el deal al nuevo stage *inmediatamente* en el estado local (React state), sin esperar al servidor. El usuario ve el cambio al instante.
2. **`handleDragEnd`** — una vez soltado, dispara `PATCH /api/deals/:id` con `{ stage, position }` en background.
3. Si el PATCH falla (red caída, etc.), el `onError` callback del hook recibe el mensaje de error. Por defecto se loguea; en producción puedes revertir el estado o mostrar un toast.

```ts
const { deals } = useKanban({
  initialDeals,
  onError: (msg) => toast.error(msg),
})
```

### Sincronización servidor

- El servidor re-numera `position` dentro de la columna destino en cada PATCH (via ROW_NUMBER en SQL).
- No hay polling ni WebSockets — si dos usuarios editan simultáneamente, el último PATCH gana. Para equipos grandes, considerar añadir un campo `version` optimista.

### Mobile

- **< 768px** (`md:hidden`): vista de tabs. Un `<select>` de stages muestra la columna activa a pantalla completa. Sin scroll horizontal.
- **≥ 768px** (`hidden md:flex`): scroll horizontal con `snap-x snap-mandatory` para deslizamiento suave entre columnas.
- El `TouchSensor` de `@dnd-kit` está activo con `delay: 200ms` para no interferir con el scroll natural en mobile.

### Tests

Los tests usan mocks de `@dnd-kit/core` y `@dnd-kit/sortable` para renderizar los componentes sin necesitar un entorno de puntero real. La lógica de drag se testea directamente con `renderHook` sobre `useKanban`.

```bash
npx vitest run components/kanban
```

---

## API

| Endpoint               | Método | Descripción                              |
|------------------------|--------|------------------------------------------|
| `GET /api/deals`       | GET    | Deals agrupados por stage                |
| `POST /api/deals`      | POST   | Crear deal (`title` requerido)           |
| `PATCH /api/deals/:id` | PATCH  | Actualizar stage, position u otros campos|
| `DELETE /api/deals/:id`| DELETE | Eliminar deal                            |
