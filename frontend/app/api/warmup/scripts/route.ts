/**
 * GET  /api/warmup/scripts  — lista todos los scripts con conteo de pasos
 * POST /api/warmup/scripts  — crea un script con sus pasos (transacción)
 */

import { NextRequest, NextResponse } from 'next/server'
import { query }                     from '@/lib/db'

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const scripts = await query<{
      id:          string
      name:        string
      description: string | null
      total_steps: number
      created_at:  string
    }>(`
      SELECT
        s.id,
        s.name,
        s.description,
        s.total_steps,
        s.created_at
      FROM warmup_scripts s
      ORDER BY s.created_at DESC
    `)

    return NextResponse.json({ scripts })
  } catch (err) {
    console.error('[warmup/scripts GET]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────

interface StepInput {
  stepOrder:    number
  speakerAlias: string
  content:      string
}

interface CreateScriptBody {
  name:        string
  description?: string
  steps:       StepInput[]
}

export async function POST(req: NextRequest) {
  try {
    const body: CreateScriptBody = await req.json()

    // Validaciones básicas
    if (!body.name?.trim()) {
      return NextResponse.json({ error: 'El nombre del script es requerido' }, { status: 400 })
    }

    if (!Array.isArray(body.steps) || body.steps.length < 2) {
      return NextResponse.json(
        { error: 'El script necesita al menos 2 pasos' },
        { status: 400 },
      )
    }

    if (body.steps.length > 200) {
      return NextResponse.json(
        { error: 'El script no puede tener más de 200 pasos' },
        { status: 400 },
      )
    }

    const aliases = new Set(body.steps.map(s => s.speakerAlias))
    if (aliases.size < 2) {
      return NextResponse.json(
        { error: 'El script necesita al menos 2 participantes distintos' },
        { status: 400 },
      )
    }

    // Insertar script
    const [script] = await query<{ id: string }>(`
      INSERT INTO warmup_scripts (name, description, total_steps)
      VALUES ($1, $2, $3)
      RETURNING id
    `, [body.name.trim(), body.description?.trim() ?? null, body.steps.length])

    // Insertar pasos en batch
    if (body.steps.length > 0) {
      const placeholders = body.steps.map((_, i) => {
        const base = i * 4
        return `($${base + 1}::uuid, $${base + 2}::int, $${base + 3}, $${base + 4})`
      }).join(', ')

      const values = body.steps.flatMap(s => [
        script.id,
        s.stepOrder,
        s.speakerAlias,
        s.content,
      ])

      await query(`
        INSERT INTO warmup_script_steps (script_id, step_order, speaker_alias, content)
        VALUES ${placeholders}
      `, values)
    }

    return NextResponse.json({ id: script.id }, { status: 201 })
  } catch (err) {
    console.error('[warmup/scripts POST]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
