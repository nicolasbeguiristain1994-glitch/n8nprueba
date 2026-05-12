# Frontend — WhatsApp Automation Platform

Next.js 15 (App Router) con TypeScript y Tailwind. Sirve tanto el dashboard interactivo como las API routes que consumen la DB y los servicios externos.

---

## Setup local

```bash
# Desde la raíz del repo
cp .env.example frontend/.env.local
# Editar frontend/.env.local con valores reales (nunca comitear)

cd frontend
npm install
npm run dev
# → http://localhost:3000
```

---

## Estructura relevante

```
frontend/
├── app/
│   ├── api/
│   │   ├── dashboard/
│   │   │   ├── casino/          → GET resumen casino (soporta ?platform=)
│   │   │   │   ├── players/     → GET lista paginada de jugadores
│   │   │   │   ├── risk/        → GET indicadores de riesgo
│   │   │   │   └── sync/        → POST lanzar sync en background
│   │   │   └── crm/             → KPIs de CRM + tareas pendientes
│   │   └── ...
│   └── dashboard/
│       └── page.tsx             → Página principal del dashboard
├── components/
│   └── dashboard/
│       ├── Dashboard.tsx        → Contenedor raíz
│       ├── DashboardHeader.tsx  → Controles: rango fecha, plataforma, autorefresh
│       ├── WidgetGrid.tsx       → Grid drag-and-drop de widgets
│       ├── useDashboard.ts      → Estado centralizado + fetch
│       └── widgets/             → Componentes individuales (KPI, Agentes, VIPs, etc.)
└── lib/
    ├── casino-agents.ts         → Agentes permitidos por plataforma
    ├── db.ts                    → Pool de PostgreSQL
    └── permissions.ts           → Control de acceso por rol
```

---

## Selector de plataforma casino

El header del dashboard incluye un selector **Zeus / Bet30** que filtra todos los widgets de casino. La preferencia se persiste en `localStorage` con la clave `dashboard:platform`.

Al cambiar de plataforma, `useDashboard` vuelve a llamar a `/api/dashboard/casino?platform=<p>` (y rutas relacionadas). Las API routes validan el parámetro contra la lista en `frontend/lib/casino-agents.ts`.

**Para agregar una nueva plataforma al selector:**

1. Extender `PLATFORMS` y `PLATFORM_AGENTS` en `frontend/lib/casino-agents.ts`
2. Agregar la entrada correspondiente en `src/config/platforms.config.json`
3. Crear el conector en `src/casino-connectors/` (ver guía en ese README)

---

## Estado del dashboard (`useDashboard`)

| Clave localStorage        | Default    | Descripción                              |
|---------------------------|------------|------------------------------------------|
| `dashboard:layout`        | orden base | Orden y visibilidad de widgets           |
| `dashboard:dateRange`     | últimos 7d | Rango de fechas del date picker          |
| `dashboard:autoRefresh`   | `true`     | Auto-refresh cada 5 minutos              |
| `dashboard:platform`      | `zeus`     | Plataforma casino seleccionada           |

---

## API Routes — Casino

Todas requieren sesión autenticada. El parámetro `?platform=` es opcional (default: `zeus`).

| Ruta                                   | Método | Descripción                                   |
|----------------------------------------|--------|-----------------------------------------------|
| `/api/dashboard/casino`                | GET    | Resumen global, por agente, VIPs, segmentación|
| `/api/dashboard/casino/players`        | GET    | Lista paginada con filtros y modo período      |
| `/api/dashboard/casino/risk`           | GET    | Extractores, déficit, VIPs recuperables        |
| `/api/dashboard/casino/sync`           | POST   | Lanza sync en background (solo admins)         |

**Sync desde el dashboard:**
```
POST /api/dashboard/casino/sync?platform=bet30&desde=2026-05-01&hasta=2026-05-12
POST /api/dashboard/casino/sync?platform=zeus          # modo --auto
```

Requiere que las variables `BET30_API_KEY` y `BET30_PLAYER_TOKEN` (o las de Zeus) estén configuradas en el servidor.

---

## Typecheck y build

```bash
npx tsc --noEmit   # verificar tipos
npm run build      # build de producción
```

Ambos deben pasar antes de abrir un PR.
