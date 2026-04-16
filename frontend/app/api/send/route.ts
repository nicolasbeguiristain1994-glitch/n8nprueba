import { NextRequest, NextResponse } from 'next/server'

const N8N_URL = process.env.NEXT_PUBLIC_N8N_URL || 'https://zestful-learning-production-537c.up.railway.app'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { phones, message, campaign_id, media_url, media_type } = body

  if (!phones?.length || !message) {
    return NextResponse.json({ error: 'phones y message son requeridos' }, { status: 400 })
  }

  const results = []
  for (const phone of phones) {
    try {
      const res = await fetch(`${N8N_URL}/webhook/send-whatsapp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, message, campaign_id, media_url, media_type, source: 'dashboard' }),
      })
      const data = await res.json()
      results.push({ phone, ...data })
    } catch (e) {
      results.push({ phone, status: 'error', error: String(e) })
    }
    // Pausa entre envíos
    await new Promise(r => setTimeout(r, 200))
  }

  return NextResponse.json({ results, total: phones.length })
}
