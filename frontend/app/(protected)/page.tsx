'use client'

import { useEffect, useState } from 'react'
import { Dashboard } from '@/components/dashboard/Dashboard'

export default function DashboardPage() {
  // Keep saved browser filters out of SSR hydration, while preloading dashboard
  // code with the page instead of downloading another chunk after it mounts.
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  return mounted ? <Dashboard /> : <p role="status" className="p-6 text-sm text-muted-foreground">Preparando dashboard…</p>
}
