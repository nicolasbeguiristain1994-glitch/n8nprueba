/**
 * GET  /api/warmup/conversations  — lista conversaciones (con filtro de status)
 * POST /api/warmup/conversations  — crea una conversación entre dos líneas
 */

import { NextRequest, NextResponse } from 'next/server'
import { query }                     from '@/lib/db'
import { nextSendAt }                from '@/lib/warmup-conversation-engine'

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const status           = searchParams.get('status') // pending|in_progress|completed|failed|paused|all

    const statusFilter = (!status || status === 'all')
      ? `status IN ('pending','in_progress','paused')`
      : `status = $1`

    const params = (!status || status === 'all') ? [] : [status]

    const conversations = await query<{
      id:             string
      script_id:      string
      script_name:    string
      line_a_id:      string
      line_b_id:      string
      line_a_phone:   string
      line_b_phone:   string
      line_a_instance: string
      line_b_instance: string
      alias_a:        string
      alias_b:        string
      current_step:   number
      total_steps:    number
      status:         string
      next_send_at:   string | null
      messages_sent:  number
      started_at:     string | null
      completed_at:   string | null
      created_at:     string
    }>(`
      SELECT
        wc.id,
        wc.script_id,
        ws.name          AS script_name,
        wc.line_a_id,
        wc.line_b_id,
        la.phone_number  AS line_a_phone,
        lb.phone_number  AS line_b_phone,
        la.instance_name AS line_a_instance,
        lb.instance_name AS line_b_instance,
        wc.alias_a,
        wc.alias_b,
        wc.current_step,
        ws.total_steps,
        wc.status,
        wc.next_send_at,
        wc.messages_sent,
        wc.started_at,
        wc.completed_at,
        wc.created_at
      FROM  warmup_conversations wc
      JOIN  warmup_scripts  ws ON ws.id = wc.script_id
      JOIN  warmup_numbers  la ON la.id = wc.line_a_id
      JOIN  warmup_numbers  lb ON lb.id = wc.line_b_id
      WHERE ${statusFilter}
      ORDER BY wc.created_at DESC
      LIMIT 200
    `, params)

    return NextResponse.json({ conversations })
  } catch (err) {
    console.error('[warmup/conversations GET]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────

interface CreateConversationBody {
  scriptId:  string
  lineAId:   string
  lineBId:   string
  aliasA:    string
  aliasB:    string
  startAt?:  string  // ISO — si se omite, empieza de inmediato
}

export async function POST(req: NextRequest) {
  try {
    const body: CreateConversationBody = await req.json()

    if (!body.scriptId || !body.lineAId || !body.lineBId || !body.aliasA || !body.aliasB) {
      return NextResponse.json(
        { error: 'scriptId, lineAId, lineBId, aliasA y aliasB son requeridos' },
        { status: 400 },
      )
    }

    if (body.lineAId === body.lineBId) {
      return NextResponse.json(
        { error: 'Las dos líneas deben ser distintas' },
        { status: 400 },
      )
    }

    // Verificar que el script existe y tiene pasos
    const [script] = await query<{ total_steps: number }>(`
      SELECT total_steps FROM warmup_scripts WHERE id = $1
    `, [body.scriptId])

    if (!script) {
      return NextResponse.json({ error: 'Script no encontrado' }, { status: 404 })
    }

    // Verificar que los aliases son válidos en el script
    const aliasRows = await query<{ speaker_alias: string }>(`
      SELECT DISTINCT speaker_alias
      FROM warmup_script_steps
      WHERE script_id = $1
        AND speaker_alias = ANY($2)
    `, [body.scriptId, [body.aliasA, body.aliasB]])

    if (aliasRows.length < 2) {
      return NextResponse.json(
        { error: `Los aliases "${body.aliasA}" y "${body.aliasB}" deben existir en el script` },
        { status: 400 },
      )
    }

    // Verificar que ambas líneas estén activas
    const lines = await query<{ id: string; warmup_status: string }>(`
      SELECT id, warmup_status FROM warmup_numbers WHERE id = ANY($1)
    `, [[body.lineAId, body.lineBId]])

    for (const line of lines) {
      if (line.warmup_status !== 'active') {
        return NextResponse.json(
          { error: `La línea ${line.id} no está activa (estado: ${line.warmup_status})` },
          { status: 409 },
        )
      }
    }

    const sendAt = body.startAt ?? nextSendAt(0) // inmediato si no se especifica

    const [conv] = await query<{ id: string }>(`
      INSERT INTO warmup_conversations
        (script_id, line_a_id, line_b_id, alias_a, alias_b, next_send_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `, [body.scriptId, body.lineAId, body.lineBId, body.aliasA, body.aliasB, sendAt])

    return NextResponse.json({ id: conv.id }, { status: 201 })
  } catch (err) {
    console.error('[warmup/conversations POST]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
