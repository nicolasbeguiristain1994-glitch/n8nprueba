'use client'

import { useCallback } from 'react'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { type Platform } from '@/lib/casino-agents'

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
  const [platform, setPlatformStored] = useLocalStorage<Platform>('dashboard:platform', 'zeus')
  const [agent, setAgentStored]       = useLocalStorage<string>('dashboard:agent', '')

  const setPlatform = useCallback((p: Platform) => {
    setPlatformStored(p)
    setAgentStored('')
  }, [setPlatformStored, setAgentStored])

  const setAgent = useCallback((a: string) => {
    setAgentStored(a)
  }, [setAgentStored])

  return { platform, agent, setPlatform, setAgent }
}
