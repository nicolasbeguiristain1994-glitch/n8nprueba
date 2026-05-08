/**
 * POST /api/warmup/simulator
 *
 * Ejecuta una simulación "what-if" sobre el estado actual de las líneas.
 * El servidor obtiene el estado de la DB y el trend de cada línea;
 * el cliente sólo envía los parámetros del escenario.
 *
 * Body:
 *   {
 *     scenario: 'add_lines' | 'change_strategy' | 'project_health',
 *     // add_lines
 *     newLinesCount?:      number,
 *     newLinesStrategy?:   string,
 *     newLinesTargetDays?: number,
 *     // change_strategy
 *     targetStrategy?: string,
 *     lineIds?:        string[],
 *     // project_health
 *     projectionDays?: number,
 *   }
 *
 * Response:
 *   SimulationResult
 */

import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { warmingSimulatorService } from '@/lib/services/warming/warming-simulator.service'
import type { SimulatorLineInput, SimulatorInput, SimulationScenario } from '@/lib/services/warming/warming-simulator.service'
import type { DelayPreset } from '@/lib/warmup-engine'

interface LineRow {
  id:                  string
  warmup_status:       string
  current_day:         number
  target_days:         number
  health_score:        number
  delay_preset:        DelayPreset
  messages_sent_today: number
}

interface TrendRow {
  warmup_number_id: string
  newest_score:     number
  oldest_score:     number
}

const VALID_SCENARIOS: SimulationScenario[] = ['add_lines', 'change_strategy', 'project_health']
const VALID_PRESETS: DelayPreset[] = ['conservadora', 'normal', 'agresiva']

export async function POST(req: NextRequest) {
  const permErr = await checkPermission(req, 'warmup', 'read')
  if (permErr) return permErr

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const scenario = body.scenario as SimulationScenario
  if (!VALID_SCENARIOS.includes(scenario)) {
    return NextResponse.json({ error: 'scenario inválido' }, { status: 400 })
  }

  // Validar presets cuando los recibe el cliente
  const newLinesStrategy  = body.newLinesStrategy  as DelayPreset | undefined
  const targetStrategy    = body.targetStrategy    as DelayPreset | undefined

  if (newLinesStrategy && !VALID_PRESETS.includes(newLinesStrategy)) {
    return NextResponse.json({ error: 'newLinesStrategy inválido' }, { status: 400 })
  }
  if (targetStrategy && !VALID_PRESETS.includes(targetStrategy)) {
    return NextResponse.json({ error: 'targetStrategy inválido' }, { status: 400 })
  }

  try {
    const lineRows = await query<LineRow>(`
      SELECT id, warmup_status, current_day, target_days,
             COALESCE(health_score, 50)       AS health_score,
             COALESCE(delay_preset, 'normal') AS delay_preset,
             messages_sent_today
      FROM   warmup_numbers
      ORDER  BY id
    `)

    // Obtener trend (delta score) de los últimos 7 snapshots por línea
    const ids = lineRows.map(l => l.id)
    const trendRows = ids.length > 0
      ? await query<TrendRow>(`
          SELECT warmup_number_id,
                 FIRST_VALUE(score) OVER w                           AS newest_score,
                 NTH_VALUE(score, LEAST(COUNT(*) OVER w, 7)) OVER w AS oldest_score
          FROM   warmup_health_history
          WHERE  warmup_number_id = ANY($1::uuid[])
          WINDOW w AS (
            PARTITION BY warmup_number_id
            ORDER BY recorded_at DESC
            ROWS BETWEEN CURRENT ROW AND 6 FOLLOWING
          )
        `, [ids])
      : []

    // De-duplicar trend por line id (la window function devuelve N filas)
    const trendMap = new Map<string, number>()
    for (const r of trendRows) {
      if (!trendMap.has(r.warmup_number_id)) {
        trendMap.set(r.warmup_number_id, (r.newest_score ?? 0) - (r.oldest_score ?? 0))
      }
    }

    const currentLines: SimulatorLineInput[] = lineRows.map(r => ({
      id:                  r.id,
      warmup_status:       r.warmup_status,
      current_day:         r.current_day,
      target_days:         r.target_days,
      health_score:        r.health_score,
      delay_preset:        r.delay_preset,
      messages_sent_today: r.messages_sent_today,
      trendDelta:          trendMap.get(r.id) ?? 0,
    }))

    const input: SimulatorInput = {
      scenario,
      currentLines,
      newLinesCount:      body.newLinesCount      as number | undefined,
      newLinesStrategy,
      newLinesTargetDays: body.newLinesTargetDays as number | undefined,
      targetStrategy,
      lineIds:            body.lineIds            as string[] | undefined,
      projectionDays:     body.projectionDays     as number | undefined,
    }

    const result = warmingSimulatorService.simulate(input)
    return NextResponse.json(result)

  } catch (e) {
    console.error('[POST /api/warmup/simulator]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
