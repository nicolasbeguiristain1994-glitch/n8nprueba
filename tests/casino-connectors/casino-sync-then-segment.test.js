'use strict'

const { spawnSync } = require('child_process')
const path = require('path')

const WRAPPER = path.join(__dirname, '..', '..', 'scripts', 'casino-sync-then-segment.js')

/**
 * Spawns the REAL wrapper script (no mocks) against a deliberately broken
 * environment (no DATABASE_URL) so both sync-casino-players-live.js and
 * segmentar-casino-players.js bail out at their very first line — before any
 * network or DB access is attempted. This is enough to verify, without
 * touching any real service, that:
 *   - the wrapper propagates a nonzero exit code when the sync step fails
 *     (never exits 0 on failure — see plan header: "un fallo de sync NUNCA
 *     debe terminar con exit code 0")
 *   - it does NOT run the segmentation step when sync fails
 *
 * The success-chaining path (sync exit 0 → segmentation runs) is not covered
 * here — it would require either a real DATABASE_URL or refactoring the
 * wrapper to accept injectable script paths, both out of scope for this
 * phase. It is a ~20-line sequential script; reviewed by inspection.
 */
describe('scripts/casino-sync-then-segment.js', () => {
  it('propagates the sync failure exit code and skips segmentation', () => {
    const env = { ...process.env }
    delete env.DATABASE_URL

    const result = spawnSync(
      process.execPath,
      [WRAPPER, '--', '--platform=zeus', '--auto'],
      { env, encoding: 'utf8', timeout: 15_000 },
    )

    expect(result.status).not.toBe(0)
    expect(result.status).not.toBeNull()
    const output = `${result.stdout}${result.stderr}`
    expect(output).toContain('DATABASE_URL')
    // segmentar-casino-players.js's own missing-DATABASE_URL message must never
    // appear — proof the wrapper never got to the segmentation step.
    expect(output).not.toContain('[seg]')
  })
})
