// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/db', () => ({ query: vi.fn() }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
import { agentScope, canAccessAgent, AGENT_PROFILE_SECTORS } from '../agent-scope'
import { canAccess, effectivePermissions } from '../permissions'
import { CreateUserSchema } from '../schema'

describe('agent profiles', () => {
  const royal = { role: 'operator' as const, sectors: AGENT_PROFILE_SECTORS, allowed_agents: ['royal'] }
  it('grants just conversations, statistics and calendar, including replies without bulk send', () => {
    expect(Object.keys(effectivePermissions(royal)).sort()).toEqual(['calendar','conversations','estadisticas'])
    expect(canAccess(royal,'conversations','send')).toBe(true)
    expect(canAccess(royal,'send','send')).toBe(false)
    expect(canAccess(royal,'tasks','read')).toBe(false)
    expect(canAccess({...royal,role:'viewer'},'conversations','send')).toBe(false)
  })
  it('normalizes platform aliases and denies unknown nonempty grants', () => {
    expect(agentScope({...royal,allowed_agents:['adminroyal','Royal','zeusroyal']})).toEqual(['royal'])
    expect(canAccessAgent(royal,'bigwin')).toBe(false)
    expect(canAccessAgent(royal,null)).toBe(false)
    expect(agentScope({...royal,allowed_agents:['!invalid']})).toEqual([])
  })
  it('validates and persists the profile using the existing user contract', () => {
    const data = CreateUserSchema.parse({...royal,email:'royal@example.com',password:'test-password',can_download_contacts:false})
    expect(data.sectors).toEqual(AGENT_PROFILE_SECTORS)
    expect(data.allowed_agents).toEqual(['royal'])
    expect(CreateUserSchema.safeParse({...data,allowed_agents:['']}).success).toBe(false)
  })
})
