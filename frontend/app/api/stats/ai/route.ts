import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { pool } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SYSTEM_PROMPT = `Sos un analista de datos con acceso de solo lectura a la base de datos de una plataforma de automatización WhatsApp para casinos online. Tu trabajo es responder preguntas sobre jugadores, transacciones y campañas de forma clara y directa.

## Tablas disponibles

### casino_players — Jugadores de casino
- username VARCHAR — nombre de usuario (único)
- agente VARCHAR — a qué casino pertenece:
  - 'btcuno' = Betcoin
  - 'btcdos' = Farabet
  - 'zeus' = Ofizeus
  - 'zeusroyal' = Royal
  - 'bigwin' = Bigwin
- total_cargas BIGINT — monto total depositado en centavos (dividir por 100 para ARS)
- cant_cargas INT — cantidad de depósitos
- total_retiros BIGINT — monto total retirado en centavos
- cant_retiros INT — cantidad de retiros
- freq_semanal NUMERIC(6,2) — frecuencia semanal de actividad
- dias_desde_ultimo INT — días desde la última actividad
- fecha_primera DATE — fecha de primer depósito
- fecha_ultima DATE — fecha de última actividad
- seg_monto VARCHAR — segmento por monto: 'bajo', 'medio', 'vip', 'super_vip'
  - 'super_vip' = Super VIP (≥$1.000.000 en ventana de 30d)
  - 'vip' = VIP (≥$500.000 en ventana de 30d)
  - 'medio' = Medio
  - 'bajo' = Bajo
- seg_actividad VARCHAR — segmento por actividad: 'nuevo', 'frecuente', 'regular', 'ocasional', 'en_riesgo', 'inactivo', 'perdido'
- labels TEXT[] — etiquetas del jugador

### casino_transactions — Transacciones individuales
- fecha DATE — fecha de la transacción
- agente VARCHAR — casino (mismo mapeo que casino_players)
- username VARCHAR — nombre de usuario
- tipo VARCHAR — 'carga' (depósito) o 'retiro'
- monto BIGINT — monto en centavos (dividir por 100 para ARS)
- fecha_hora_utc TIMESTAMPTZ — timestamp exacto

### contacts — Contactos de WhatsApp
- id UUID
- phone VARCHAR — número de teléfono
- name VARCHAR — nombre
- segment contact_segment — segmento: 'bajo', 'medio', 'vip', 'super_vip'
- status VARCHAR — 'active', 'inactive'
- last_activity_at TIMESTAMPTZ — última interacción WhatsApp

### campaigns — Campañas de mensajería
- id UUID
- name VARCHAR — nombre de la campaña
- type VARCHAR — tipo de campaña
- status VARCHAR — 'draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled'
- created_at TIMESTAMPTZ
- completed_at TIMESTAMPTZ

### whatsapp_messages — Mensajes enviados
- status VARCHAR — 'sent', 'delivered', 'read', 'failed'
- created_at TIMESTAMPTZ
- campaign_id UUID — referencia a campaigns

## Reglas importantes
- Los montos en casino_players y casino_transactions se guardan en CENTAVOS. Siempre dividí por 100 para mostrar en ARS.
- Usá CURRENT_DATE para la fecha de hoy.
- Siempre respondé en español.
- Cuando muestres listas de usuarios, incluilas todas (no truncar).
- Formateá los montos en ARS con separadores de miles.
- Si la pregunta es ambigua, hacé la consulta más razonable y explicá qué asumiste.`

function isSelectOnly(sql: string): boolean {
  const normalized = sql.trim().toUpperCase()
  if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) return false
  const dangerous = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|EXECUTE|CALL)\b/
  return !dangerous.test(normalized)
}

async function executeSql(sql: string): Promise<string> {
  if (!isSelectOnly(sql)) {
    return JSON.stringify({ error: 'Solo se permiten consultas SELECT.' })
  }
  try {
    const result = await pool.query(sql)
    const columns = result.fields.map(f => f.name)
    const rows = result.rows.map(row => columns.map(col => row[col]))
    return JSON.stringify({ columns, rows: rows.slice(0, 500), total: result.rowCount })
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : 'Error desconocido' })
  }
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'execute_sql',
    description: 'Ejecuta una consulta SQL SELECT de solo lectura contra la base de datos. Solo se permiten SELECT.',
    input_schema: {
      type: 'object' as const,
      properties: {
        sql: { type: 'string', description: 'La consulta SQL SELECT a ejecutar' },
      },
      required: ['sql'],
    },
  },
]

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'dashboard', 'read')
  if (!auth.ok) return auth.response

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY no configurada.' }, { status: 500 })
  }

  const body = await req.json() as {
    messages: Array<{ role: 'user' | 'assistant'; content: string }>
  }

  if (!body.messages?.length) {
    return NextResponse.json({ error: 'No hay mensajes.' }, { status: 400 })
  }

  type MsgParam = Anthropic.MessageParam
  let messages: MsgParam[] = body.messages.map(m => ({
    role: m.role,
    content: m.content,
  }))

  for (let i = 0; i < 8; i++) {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages,
      tools: TOOLS,
    })

    if (response.stop_reason === 'end_turn') {
      const text = response.content.find(c => c.type === 'text')
      return NextResponse.json({ response: text ? text.text : '' })
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content })

      const results: Anthropic.ToolResultBlockParam[] = []
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue
        const input = block.input as { sql: string }
        const output = await executeSql(input.sql)
        results.push({ type: 'tool_result', tool_use_id: block.id, content: output })
      }
      messages.push({ role: 'user', content: results })
    } else {
      break
    }
  }

  return NextResponse.json({ error: 'No se pudo completar la consulta.' }, { status: 500 })
}
