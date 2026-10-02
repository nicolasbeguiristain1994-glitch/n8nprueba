import { describe, expect, it } from 'vitest'
import { SYNC_PLATFORMS, getAgentsForPlatform } from '@/lib/casino-agents'
import {
  agentScopeLabel, configuredAgentAccounts, dashboardAgent, dashboardAgentSql, dashboardAgents,
  normalizedSavedFilters, platformCanonicalAgent, platformCanonicalAgentSql,
} from '@/lib/dashboard-scope'
import { OPERATOR_ACCOUNTS } from './fixtures/operator-accounts'
const OPERATORS = Object.keys(OPERATOR_ACCOUNTS)
const CONFIGURED = SYNC_PLATFORMS.flatMap(p => getAgentsForPlatform(p).map(raw => ({ p, raw })))

/** Evaluates the generated CASE the way PostgreSQL would for one (platform, agente) row. */
function evalCanonicalSql(platform: string, agente: string): string {
  const sql = platformCanonicalAgentSql()
  const name = agente.replace(/^ +| +$/g, '').toLowerCase()
  for (const [, p, raw, canonical] of sql.matchAll(/WHEN platform = '(\w+)' AND LOWER\(BTRIM\(agente\)\) = '(\w+)' THEN '(\w+)'/g)) {
    if (p === platform && raw === name) return canonical
  }
  expect(sql).toMatch(/ELSE LOWER\(BTRIM\(agente\)\) END$/)
  return name
}

describe('dashboard agent scope — every configured platform account', () => {
  it('the consolidated selector lists exactly the configured operators', () => {
    expect([...dashboardAgents('consolidado')].sort()).toEqual([...OPERATORS].sort())
  })

  it('every configured account belongs to exactly one operator', () => {
    for (const p of SYNC_PLATFORMS) {
      const covered = OPERATORS.flatMap(op => OPERATOR_ACCOUNTS[op][p])
      expect([...covered].sort(), p).toEqual([...getAgentsForPlatform(p)].sort())
    }
  })

  describe.each(OPERATORS)('operator %s', op => {
    it.each(SYNC_PLATFORMS)('has the expected configured accounts on %s', p => {
      expect(configuredAgentAccounts('consolidado', p, op)).toEqual(OPERATOR_ACCOUNTS[op][p])
    })

    it('keeps a saved consolidated filter and explains its scope per platform', () => {
      expect(normalizedSavedFilters('consolidado', op)).toEqual({ platform: 'consolidado', agent: op })
      const scopes = SYNC_PLATFORMS.filter(p => OPERATOR_ACCOUNTS[op][p].length).map(p => `${p}: ${OPERATOR_ACCOUNTS[op][p].join(', ')}`)
      expect(agentScopeLabel('consolidado', op)).toBe([op, ...scopes].join(' · '))
    })
  })

  describe.each(CONFIGURED)('$p account $raw', ({ p, raw }) => {
    const operator = OPERATORS.find(op => OPERATOR_ACCOUNTS[op][p].includes(raw))!

    it('maps to the same operator in the UI filter, the platform mapping and the SQL CASE', () => {
      expect(dashboardAgent('consolidado', raw)).toBe(operator)
      expect(platformCanonicalAgent(p, raw)).toBe(operator)
      expect(evalCanonicalSql(p, raw)).toBe(operator)
    })

    it('ignores case and surrounding spaces stored in the database', () => {
      expect(evalCanonicalSql(p, `  ${raw.toUpperCase()} `)).toBe(operator)
      expect(platformCanonicalAgent(p, ` ${raw.toUpperCase()}`)).toBe(operator)
      expect(dashboardAgent('consolidado', ` ${raw.toUpperCase()} `)).toBe(operator)
    })

    it('is selectable as-is on its own platform', () => {
      expect(normalizedSavedFilters(p, raw)).toEqual({ platform: p, agent: raw })
      expect(configuredAgentAccounts(p, p, raw)).toEqual([raw])
      expect(normalizedSavedFilters('consolidado', raw)).toEqual({ platform: 'consolidado', agent: operator })
    })
  })

  it('never infers an alias from another platform', () => {
    for (const p of SYNC_PLATFORMS) {
      for (const { p: other, raw } of CONFIGURED) {
        if (other === p || getAgentsForPlatform(p).includes(raw)) continue
        expect(evalCanonicalSql(p, raw), `${p}/${raw}`).toBe(raw)
      }
    }
    expect(evalCanonicalSql('zeus', 'btcdos')).toBe('btcdos')
    expect(evalCanonicalSql('argenbet', 'adminfara')).toBe('adminfara')
  })

  it('filters a single platform by its raw name without the consolidated CASE', () => {
    expect(dashboardAgentSql('bet30', 3)).toBe('($3::text IS NULL OR LOWER(BTRIM(agente)) = $3)')
    expect(dashboardAgentSql('consolidado', 3)).toContain(`WHEN 'farabet' THEN ARRAY['btcdos','farabet']::text[]`)
  })

  it('returns every configured account when no agent is selected', () => {
    for (const p of SYNC_PLATFORMS) expect(configuredAgentAccounts('consolidado', p, '')).toEqual(getAgentsForPlatform(p))
  })
})
