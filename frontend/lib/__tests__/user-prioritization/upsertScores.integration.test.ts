// @vitest-environment node
/**
 * Test de integración SQL — upsertScores skip_reasons ragged arrays.
 *
 * Verifica que el fix jsonb[] + FROM UNNEST maneje correctamente arrays de
 * distinta longitud (ragged arrays) en un mismo batch.
 *
 * Usa una TEMP TABLE con la misma estructura que contact_priority_scores,
 * sin FK a contacts, para ser autocontenido y no depender de migraciones
 * aplicadas ni de datos previos.
 *
 * Precondiciones para que corra (no se salte):
 *   - DB_POSTGRESDB_HOST definido en .env
 *   - PostgreSQL accesible con las credenciales del .env
 *   - PostgreSQL >= 12 (jsonb_array_elements_text disponible desde pg 9.3)
 *
 * Si las credenciales no están disponibles, la suite se marca como skipped.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Pool, type PoolClient }                      from 'pg'
import { randomUUID }                                 from 'crypto'
import * as dotenv                                    from 'dotenv'
import * as path                                      from 'path'

// Carga .env desde la raíz del monorepo (4 niveles arriba del test file)
dotenv.config({ path: path.resolve(process.cwd(), '../.env') })

// ── Configuración de conexión ─────────────────────────────────────────────────

const DB_CONFIG = {
  host:                    process.env.DB_POSTGRESDB_HOST,
  port:                    Number(process.env.DB_POSTGRESDB_PORT ?? '5432'),
  user:                    process.env.DB_POSTGRESDB_USER,
  password:                process.env.DB_POSTGRESDB_PASSWORD,
  database:                process.env.DB_POSTGRESDB_DATABASE ?? 'railway',
  ssl:                     { rejectUnauthorized: false },
  connectionTimeoutMillis: 5000,
}

const CAN_CONNECT = Boolean(DB_CONFIG.host && DB_CONFIG.user && DB_CONFIG.password)

// ── SQL idéntico al de UserPrioritizationRepository.upsertScores ─────────────
// (solo cambia el nombre de la tabla — el resto es copia exacta del fix)

function buildUpsertSql(table: string): string {
  return `
    INSERT INTO ${table} (
      contact_id,
      priority_score,
      reactivation_segment,
      value_tier,
      value_score,
      urgency_score,
      days_inactive,
      deposit_segment,
      total_deposit_amount,
      is_eligible,
      skip_reasons,
      run_id,
      computed_at
    )
    SELECT
      t.contact_id,
      t.priority_score,
      t.reactivation_segment,
      t.value_tier,
      t.value_score,
      t.urgency_score,
      t.days_inactive,
      t.deposit_segment,
      t.total_deposit_amount,
      t.is_eligible,
      ARRAY(SELECT jsonb_array_elements_text(COALESCE(t.skip_reasons_json, '[]'::jsonb))),
      $12::uuid,
      NOW()
    FROM UNNEST(
      $1::uuid[],
      $2::numeric[],
      $3::text[],
      $4::text[],
      $5::smallint[],
      $6::smallint[],
      $7::int[],
      $8::text[],
      $9::numeric[],
      $10::boolean[],
      $11::jsonb[]
    ) AS t(
      contact_id,
      priority_score,
      reactivation_segment,
      value_tier,
      value_score,
      urgency_score,
      days_inactive,
      deposit_segment,
      total_deposit_amount,
      is_eligible,
      skip_reasons_json
    )
    ON CONFLICT (contact_id) DO UPDATE SET
      priority_score       = EXCLUDED.priority_score,
      reactivation_segment = EXCLUDED.reactivation_segment,
      value_tier           = EXCLUDED.value_tier,
      value_score          = EXCLUDED.value_score,
      urgency_score        = EXCLUDED.urgency_score,
      days_inactive        = EXCLUDED.days_inactive,
      deposit_segment      = EXCLUDED.deposit_segment,
      total_deposit_amount = EXCLUDED.total_deposit_amount,
      is_eligible          = EXCLUDED.is_eligible,
      skip_reasons         = EXCLUDED.skip_reasons,
      run_id               = EXCLUDED.run_id,
      computed_at          = NOW()
  `
}

// ── Tipos y helpers ───────────────────────────────────────────────────────────

type ScoreInput = {
  contactId:           string
  priorityScore:       number
  reactivationSegment: string | null
  valueTier:           string
  valueScore:          number
  urgencyScore:        number
  daysInactive:        number | null
  depositSegment:      string | null
  totalDepositAmount:  number | null
  isEligible:          boolean
  skipReasons:         string[]
}

function makeScore(contactId: string, skipReasons: string[]): ScoreInput {
  return {
    contactId,
    priorityScore:       50,
    reactivationSegment: null,
    valueTier:           'medio',
    valueScore:          25,
    urgencyScore:        25,
    daysInactive:        30,
    depositSegment:      null,
    totalDepositAmount:  null,
    isEligible:          skipReasons.length === 0,
    skipReasons,
  }
}

async function upsert(
  client: PoolClient,
  table: string,
  scores: ScoreInput[],
  runId?: string,
): Promise<void> {
  await client.query(buildUpsertSql(table), [
    scores.map(s => s.contactId),
    scores.map(s => s.priorityScore),
    scores.map(s => s.reactivationSegment),
    scores.map(s => s.valueTier),
    scores.map(s => s.valueScore),
    scores.map(s => s.urgencyScore),
    scores.map(s => s.daysInactive),
    scores.map(s => s.depositSegment),
    scores.map(s => s.totalDepositAmount),
    scores.map(s => s.isEligible),
    scores.map(s => JSON.stringify(s.skipReasons)),
    runId ?? null,
  ])
}

async function readSkipReasons(
  client: PoolClient,
  table: string,
  ids: string[],
): Promise<Record<string, string[]>> {
  const { rows } = await client.query<{ contact_id: string; skip_reasons: string[] }>(
    `SELECT contact_id, skip_reasons FROM ${table} WHERE contact_id = ANY($1)`,
    [ids],
  )
  return Object.fromEntries(rows.map(r => [r.contact_id, r.skip_reasons]))
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe.skipIf(!CAN_CONNECT)(
  'upsertScores — integración SQL real (ragged skip_reasons)',
  () => {
    const TABLE = 'tmp_cps_skip_reasons_test'
    let pool:   Pool
    let client: PoolClient

    beforeAll(async () => {
      pool   = new Pool(DB_CONFIG)
      client = await pool.connect()

      // Tabla temporal con la misma estructura relevante que contact_priority_scores
      // Sin FK a contacts → autocontenido, sin dependencia de migraciones aplicadas.
      // Se destruye automáticamente al cerrar la conexión.
      await client.query(`
        CREATE TEMP TABLE ${TABLE} (
          contact_id           UUID         NOT NULL,
          priority_score       NUMERIC(5,2) NOT NULL DEFAULT 0,
          reactivation_segment TEXT,
          value_tier           TEXT         NOT NULL DEFAULT 'bajo',
          value_score          SMALLINT     NOT NULL DEFAULT 0,
          urgency_score        SMALLINT     NOT NULL DEFAULT 0,
          days_inactive        INTEGER,
          deposit_segment      TEXT,
          total_deposit_amount NUMERIC(14,2),
          is_eligible          BOOLEAN      NOT NULL DEFAULT false,
          skip_reasons         TEXT[]       NOT NULL DEFAULT '{}',
          run_id               UUID,
          computed_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
          UNIQUE (contact_id)
        ) ON COMMIT PRESERVE ROWS
      `)
    })

    afterAll(async () => {
      await client.query(`DROP TABLE IF EXISTS ${TABLE}`)
      client.release()
      await pool.end()
    })

    // ── Caso 1: INSERT con ragged arrays en el mismo batch ──────────────────

    it('INSERT — longitudes 0, 1 y 2 en el mismo batch no lanza y persiste correctamente', async () => {
      const [c0, c1, c2] = [randomUUID(), randomUUID(), randomUUID()]

      await expect(
        upsert(client, TABLE, [
          makeScore(c0, []),
          makeScore(c1, ['too_cold']),
          makeScore(c2, ['status_invalid', 'opted_out']),
        ]),
      ).resolves.not.toThrow()

      const byId = await readSkipReasons(client, TABLE, [c0, c1, c2])
      expect(byId[c0]).toEqual([])
      expect(byId[c1]).toEqual(['too_cold'])
      expect(byId[c2]).toEqual(['status_invalid', 'opted_out'])
    })

    // ── Caso 2: Sin mezcla entre filas ──────────────────────────────────────

    it('no mezcla skip_reasons entre filas del mismo batch', async () => {
      const [cA, cB] = [randomUUID(), randomUUID()]

      await upsert(client, TABLE, [
        makeScore(cA, ['do_not_contact', 'opted_out', 'deleted']),
        makeScore(cB, []),
      ])

      const byId = await readSkipReasons(client, TABLE, [cA, cB])
      expect(byId[cA]).toEqual(['do_not_contact', 'opted_out', 'deleted'])
      expect(byId[cB]).toEqual([])
    })

    // ── Caso 3: UPSERT (ON CONFLICT) sobreescribe skip_reasons ─────────────

    it('UPDATE path — sobreescribe skip_reasons con arrays de distinta longitud', async () => {
      const c = randomUUID()

      await upsert(client, TABLE, [makeScore(c, ['too_cold'])])
      await upsert(client, TABLE, [makeScore(c, ['do_not_contact', 'opted_out'])])

      const byId = await readSkipReasons(client, TABLE, [c])
      expect(byId[c]).toEqual(['do_not_contact', 'opted_out'])
    })

    it('UPDATE path — sobreescribe array no-vacío con vacío', async () => {
      const c = randomUUID()

      await upsert(client, TABLE, [makeScore(c, ['too_cold', 'opted_out'])])
      await upsert(client, TABLE, [makeScore(c, [])])

      const byId = await readSkipReasons(client, TABLE, [c])
      expect(byId[c]).toEqual([])
    })

    // ── Caso 4: batch de un solo contacto ───────────────────────────────────

    it('batch de un solo elemento con array vacío no lanza', async () => {
      const c = randomUUID()
      await expect(upsert(client, TABLE, [makeScore(c, [])])).resolves.not.toThrow()
      const byId = await readSkipReasons(client, TABLE, [c])
      expect(byId[c]).toEqual([])
    })

    // ── Caso 5: batch grande heterogéneo ────────────────────────────────────

    it('batch de 10 contactos con longitudes variadas no mezcla datos', async () => {
      const cases: Array<[string, string[]]> = Array.from({ length: 10 }, (_, i) => {
        const id     = randomUUID()
        const length = i % 4  // 0, 1, 2, 3 motivos
        const reasons = ['too_cold', 'opted_out', 'do_not_contact', 'deleted'].slice(0, length)
        return [id, reasons]
      })

      await upsert(
        client,
        TABLE,
        cases.map(([id, reasons]) => makeScore(id, reasons)),
      )

      const ids   = cases.map(([id]) => id)
      const byId  = await readSkipReasons(client, TABLE, ids)

      for (const [id, expectedReasons] of cases) {
        expect(byId[id]).toEqual(expectedReasons)
      }
    })

    // ── Nota sobre null/undefined ────────────────────────────────────────────
    //
    // `skipReasons` es `string[]` en TypeScript (nunca null/undefined según los tipos).
    // `checkEligibility` siempre retorna un array (mínimo []). No hay camino de código
    // que produzca null/undefined para skipReasons, por lo que no se fuerza ese caso.
    // La expresión SQL COALESCE(t.skip_reasons_json, '[]'::jsonb) protege contra
    // un NULL en el array de jsonb, pero eso solo podría venir de un bug de tipo.
  },
)
