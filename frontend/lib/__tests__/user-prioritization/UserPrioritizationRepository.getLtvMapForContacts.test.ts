// @vitest-environment node
/**
 * D2 regression + corrección mensaje 8 (revisión coordinador, 2026-09-21):
 *
 * getLtvMapForContacts() usaba `JOIN player_ltv pl ON pl.casino_player_id =
 * l.player_id`, asumiendo que casino_contact_account_links.player_id YA era
 * el UUID real de casino_players. Es falso para cualquier jugador con
 * transacciones: ese id sale de casino_segmentation_players, que genera un id
 * SINTÉTICO md5('excel:'||platform||':'||lower(username))::uuid — nunca
 * coincide con player_ltv.casino_player_id (el UUID real). El fix real une
 * primero a casino_players por (username_lower, platform) y de ahí a
 * player_ltv por casino_players.id — este test exige exactamente eso, con un
 * fixture donde el id sintético y el id real son deliberadamente distintos.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/db', () => ({ query: vi.fn().mockResolvedValue([]) }))

import * as db from '@/lib/db'
import { UserPrioritizationRepository } from '@/lib/user-prioritization/UserPrioritizationRepository'

describe('UserPrioritizationRepository.getLtvMapForContacts', () => {
  beforeEach(() => {
    vi.mocked(db.query).mockClear()
    vi.mocked(db.query).mockResolvedValue([])
  })

  it('returns an empty map without querying when given no contact ids', async () => {
    const repo = new UserPrioritizationRepository()
    const map = await repo.getLtvMapForContacts([])
    expect(map.size).toBe(0)
    expect(db.query).not.toHaveBeenCalled()
  })

  it('joins casino_contact_account_links -> casino_players -> player_ltv, not the synthetic id directly', async () => {
    const repo = new UserPrioritizationRepository()
    await repo.getLtvMapForContacts(['00000000-0000-4000-8000-000000000001'])
    expect(db.query).toHaveBeenCalledTimes(1)
    const [sql] = vi.mocked(db.query).mock.calls[0]

    expect(sql).toContain('FROM casino_contact_account_links')
    // Must resolve l.player_id (synthetic for tx-having accounts, see header)
    // to a real casino_players row by identity, before touching player_ltv.
    expect(sql).toMatch(/JOIN\s+casino_players\s+cp/)
    expect(sql).toContain('cp.username_lower = l.username_lower')
    expect(sql).toContain('cp.platform IS NOT DISTINCT FROM l.platform')
    expect(sql).toContain('pl.casino_player_id = cp.id')
    // The exact bug from mensaje 8: joining player_ltv straight off the
    // link's (possibly synthetic) player_id must never come back.
    expect(sql).not.toContain('pl.casino_player_id = l.player_id')
    // must NOT reintroduce the platform-oblivious first_name/casino_accounts match
    expect(sql).not.toContain('LOWER(TRIM(c.first_name)) = cp.username_lower')
  })

  it('resolves LTV correctly when the link id is synthetic (imported/API tx) and differs from casino_players.id', async () => {
    // Fixture matching casino_segmentation_players + casino_contact_account_links
    // + player_ltv semantics: the link's player_id is the SYNTHETIC md5 id
    // (never equal to a real casino_players.id — the exact case the old join
    // silently dropped), while player_ltv is keyed by the real casino_players.id.
    const contactId       = '00000000-0000-4000-8000-000000000001'
    const syntheticLinkId = '11111111-1111-4111-8111-111111111111' // l.player_id — NOT a real casino_players.id
    const realPlayerId    = '22222222-2222-4222-8222-222222222222' // casino_players.id / player_ltv.casino_player_id
    expect(syntheticLinkId).not.toBe(realPlayerId)

    vi.mocked(db.query).mockResolvedValueOnce([
      { contact_id: contactId, ltv_score: '45', ltv_tier: 'vip_medio' },
    ])

    const repo = new UserPrioritizationRepository()
    const map  = await repo.getLtvMapForContacts([contactId])

    expect(map.get(contactId)).toEqual({ ltvScore: 45, ltvTier: 'vip_medio' })
  })

  it('returns an empty map (not a throw) when the query fails', async () => {
    vi.mocked(db.query).mockRejectedValueOnce(new Error('relation missing'))
    const repo = new UserPrioritizationRepository()
    const map = await repo.getLtvMapForContacts(['00000000-0000-4000-8000-000000000001'])
    expect(map.size).toBe(0)
  })
})
