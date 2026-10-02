'use client'

import dynamic from 'next/dynamic'

// Browser-persisted filters must not be hydrated over different server defaults.
const Dashboard = dynamic(() => import('@/components/dashboard/Dashboard').then(m => m.Dashboard), {
  ssr: false,
  loading: () => <p role="status" className="p-6 text-sm text-muted-foreground">Preparando dashboard…</p>,
})

export default function DashboardPage() {
  return <Dashboard />
}
