import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

const N8N_URL = process.env.NEXT_PUBLIC_N8N_URL || 'https://zestful-learning-production-537c.up.railway.app'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const [campaign] = await query<{
    id: string; name: string; message: string; messages: string[] | null; media_url: string
    list_id: string; antiblock_delay_min: number; antiblock_delay_max: number
    personalize_name: boolean
  }>('SELECT * FROM campaigns WHERE id = $1', [id])

  if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })

  const contacts = await query<{ phone_number: string; first_name: string; id: string }>(
    `SELECT c.phone_number, c.first_name, c.id
     FROM contacts c
     JOIN contact_list_members clm ON clm.contact_id = c.id
     WHERE clm.list_id = $1
       AND c.opt_in_marketing = true
       AND c.do_not_contact = false
       AND c.status = 'active'`,
    [campaign.list_id]
  )

  if (!contacts.length) return NextResponse.json({ error: 'No contacts in list' }, { status: 400 })

  await query(
    `UPDATE campaigns SET status = 'running', started_at = NOW(), total_targets = $1,
     total_sent = 0, total_failed = 0 WHERE id = $2`,
    [contacts.length, id]
  )

  // Envío en background — responde inmediatamente
  ;(async () => {
    let sent = 0, failed = 0

    for (const contact of contacts) {
      // Verificar si fue pausada o cancelada antes de cada mensaje
      const [current] = await query<{ status: string }>('SELECT status FROM campaigns WHERE id = $1', [id])
      if (current?.status === 'paused' || current?.status === 'cancelled') break

      // Pick a random message variant
      const msgPool = Array.isArray(campaign.messages) && campaign.messages.length > 0
        ? campaign.messages
        : [campaign.message]
      const rawMsg = msgPool[Math.floor(Math.random() * msgPool.length)]

      const nameValue = campaign.personalize_name !== false ? (contact.first_name || '') : ''
      const personalizedMsg = rawMsg
        .replace(/\{\{nombre\}\}/gi, nameValue)
        .replace(/\{\{name\}\}/gi, nameValue)

      try {
        const res = await fetch(`${N8N_URL}/webhook/send-whatsapp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phone: contact.phone_number,
            message: personalizedMsg,
            campaign_id: id,
            campaign_name: campaign.name,
            contact_id: contact.id,
            media_url: campaign.media_url || undefined,
            source: 'campaign',
            antiblock_delay_min: campaign.antiblock_delay_min,
            antiblock_delay_max: campaign.antiblock_delay_max,
          }),
        })

        // Éxito si HTTP 2xx — n8n puede responder con body vacío
        if (res.ok) {
          sent++
          // Capturar el evolution_message_id desde la respuesta de n8n (si lo devuelve)
          let evolutionMsgId: string | null = null
          try {
            const responseData = await res.json()
            // n8n puede devolver { key: { id: "..." }, ... } o { id: "..." }
            evolutionMsgId = responseData?.key?.id || responseData?.id || null
          } catch { /* n8n respondió con body vacío — está bien */ }

          // Insertar en whatsapp_messages para que el webhook de Evolution pueda actualizar el estado
          await query(
            `INSERT INTO whatsapp_messages
               (contact_id, campaign_id, phone_number, message_body, direction, status,
                evolution_message_id, sent_at, created_at, updated_at)
             VALUES ($1, $2, $3, $4, 'outbound', 'sent', $5, NOW(), NOW(), NOW())`,
            [contact.id, id, contact.phone_number, personalizedMsg, evolutionMsgId]
          )
        } else {
          // Intentar leer el error si hay body
          let errDetail: string | number = res.status
          try { const d = await res.json(); errDetail = d?.message || res.status } catch { /* ignore */ }
          console.error(`[campaign ${id}] Error ${errDetail} para ${contact.phone_number}`)
          failed++

          // Registrar el fallo en whatsapp_messages también
          await query(
            `INSERT INTO whatsapp_messages
               (contact_id, campaign_id, phone_number, message_body, direction, status,
                failed_at, error_detail, created_at, updated_at)
             VALUES ($1, $2, $3, $4, 'outbound', 'failed', NOW(), $5, NOW(), NOW())`,
            [contact.id, id, contact.phone_number, personalizedMsg, String(errDetail)]
          )
        }
      } catch (e) {
        console.error(`[campaign ${id}] Excepción para ${contact.phone_number}:`, e)
        failed++
        await query(
          `INSERT INTO whatsapp_messages
             (contact_id, campaign_id, phone_number, message_body, direction, status,
              failed_at, error_detail, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'outbound', 'failed', NOW(), $5, NOW(), NOW())`,
          [contact.id, id, contact.phone_number, personalizedMsg, e instanceof Error ? e.message : 'network error']
        )
      }

      // Actualizar progreso en la DB cada mensaje
      await query(
        `UPDATE campaigns SET total_sent = $1, total_failed = $2 WHERE id = $3`,
        [sent, failed, id]
      )

      // Delay antibloqueo entre mensajes (excepto en el último)
      const isLast = contact === contacts[contacts.length - 1]
      if (!isLast) {
        const delaySec = Math.floor(Math.random() * (campaign.antiblock_delay_max - campaign.antiblock_delay_min + 1)) + campaign.antiblock_delay_min
        await new Promise(r => setTimeout(r, delaySec * 1000))
      }
    }

    // Solo marcar completed si no fue pausada/cancelada
    const [finalState] = await query<{ status: string }>('SELECT status FROM campaigns WHERE id = $1', [id])
    if (finalState?.status === 'running') {
      await query(`UPDATE campaigns SET status = 'completed', completed_at = NOW() WHERE id = $1`, [id])
    }
  })()

  return NextResponse.json({ started: true, total: contacts.length })
}
