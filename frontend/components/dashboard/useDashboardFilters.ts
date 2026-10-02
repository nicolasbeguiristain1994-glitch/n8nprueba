'use client'

import { useCallback, useEffect } from 'react'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { type Platform } from '@/lib/casino-agents'
import { normalizedSavedFilters } from '@/lib/dashboard-scope'

export interface DashboardFilters {
  platform:    Platform
  agent:       string
  setPlatform: (p: Platform) => void
  setAgent:    (a: string) => void
}

/**
 * Manages platform + agent filter state persisted in localStorage.
 * Resets the agent selection automatically when the platform changes
 * (agent names are platform-specific).
 */
export function useDashboardFilters(): DashboardFilters {
  const [storedPlatform, setPlatformStored] = useLocalStorage<Platform>('dashboard:platform', 'consolidado')
  const [storedAgent, setAgentStored]       = useLocalStorage<string>('dashboard:agent', '')

  const { platform, agent } = normalizedSavedFilters(storedPlatform, storedAgent)
  useEffect(() => {
    if (platform !== storedPlatform) setPlatformStored(platform)
    if (agent !== storedAgent) setAgentStored(agent)
  }, [platform, agent, storedPlatform, storedAgent, setPlatformStored, setAgentStored])

  const setPlatform = useCallback((p: Platform) => {
    setPlatformStored(p)
    setAgentStored('')
  }, [setPlatformStored, setAgentStored])

  const setAgent = useCallback((a: string) => {
    setAgentStored(a)
  }, [setAgentStored])

  return { platform, agent, setPlatform, setAgent }
}
