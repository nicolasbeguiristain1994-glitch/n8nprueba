import { createHash } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { getDbClient, query } from '@/lib/db'
import { signStickerToken, verifyStickerToken, stickerPreview } from '@/lib/conversation-stickers'

const slotOf = (req: NextRequest) => Number(req.nextUrl.searchParams.get('slot'))
const validSlot = (slot: number) => Number.isInteger(slot) && slot >= 1 && slot <= 24
const json = (value: unknown, status = 200) => NextResponse.json(value, {status, headers:{'Cache-Control':'private, no-store'}})

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'send', 'send')
  if (!auth.ok) return auth.response
  try {
    if (req.nextUrl.searchParams.has('slot')) {
      const slot = slotOf(req)
      if (!validSlot(slot)) return json({error:'Favorito inválido.'},400)
      const [row] = await query<{data_uri:string;name:string}>('SELECT data_uri,name FROM conversation_sticker_favorites WHERE user_id=$1 AND slot=$2',[auth.user.user_id,slot])
      if (!row) return json({error:'Ese favorito ya no existe.'},404)
      return json({url:row.data_uri, token:signStickerToken(row.data_uri,auth.user.user_id),name:row.name,slot})
    }
    const favorites = await query('SELECT slot,name,preview FROM conversation_sticker_favorites WHERE user_id=$1 ORDER BY created_at,slot',[auth.user.user_id])
    return json({favorites})
  } catch { return json({error:'No se pudieron cargar tus favoritos.'},500) }
}

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req,'send','send')
  if (!auth.ok) return auth.response
  const body = await req.json().catch(()=>null)
  if (!body || typeof body.url !== 'string' || body.url.length>700000 || !body.url.startsWith('data:image/webp;base64,') || !verifyStickerToken(body.token,body.url,auth.user.user_id)) return json({error:'Volvé a cargar el sticker antes de guardarlo.'},400)
  const name = typeof body.name==='string' ? body.name.trim().slice(0,80) : ''
  if (!name) return json({error:'Escribí un nombre para el favorito.'},400)
  const client = await getDbClient()
  try {
    const preview = await stickerPreview(body.url)
    const digest = createHash('sha256').update(body.url).digest('hex')
    await client.query('BEGIN')
    // Serialize saves for one user; fixed slots also bound storage under concurrent requests.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,144))',[auth.user.user_id])
    const {rows:existing} = await client.query('SELECT slot FROM conversation_sticker_favorites WHERE user_id=$1 AND digest=$2',[auth.user.user_id,digest])
    if (existing.length) { await client.query('COMMIT'); return json({slot:existing[0].slot}) }
    const {rows:slots} = await client.query('SELECT n AS slot FROM generate_series(1,24) n WHERE NOT EXISTS (SELECT 1 FROM conversation_sticker_favorites WHERE user_id=$1 AND slot=n) ORDER BY n LIMIT 1',[auth.user.user_id])
    if (!slots.length) { await client.query('ROLLBACK'); return json({error:'Llegaste a 24 favoritos. Quitá uno para guardar otro.'},409) }
    await client.query('INSERT INTO conversation_sticker_favorites(user_id,slot,digest,name,data_uri,preview) VALUES($1,$2,$3,$4,$5,$6)',[auth.user.user_id,slots[0].slot,digest,name,body.url,preview])
    await client.query('COMMIT')
    return json({slot:slots[0].slot},201)
  } catch { await client.query('ROLLBACK').catch(()=>{}); return json({error:'No se pudo guardar el favorito.'},500) }
  finally { client.release() }
}

export async function DELETE(req: NextRequest) {
  const auth = await checkPermissionWithUser(req,'send','send')
  if (!auth.ok) return auth.response
  const slot=slotOf(req)
  if (!validSlot(slot)) return json({error:'Favorito inválido.'},400)
  try {
    await query('DELETE FROM conversation_sticker_favorites WHERE user_id=$1 AND slot=$2',[auth.user.user_id,slot])
    return json({ok:true})
  } catch { return json({error:'No se pudo quitar el favorito.'},500) }
}
