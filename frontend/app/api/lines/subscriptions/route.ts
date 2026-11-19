import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { getAccessibleLineIds } from '@/lib/line-visibility'
import { audit } from '@/lib/audit'
import { saveSubscriptionSettings, type SubscriptionSettings } from '@/lib/line-subscriptions'
import { subscriptionLink, subscriptionMessageError } from '@/lib/line-subscription-message'

const Id = z.string().uuid()
const Flow = z.object({welcome:z.string().trim().min(1).max(3000),confirmation:z.string().trim().min(1).max(3000),goodbye:z.string().trim().min(1).max(3000)}).strict()
const Settings = z.object({
  lineId: Id, brandName: z.string().trim().min(2).max(100),
  message: z.string().trim().min(20).max(1000), enabled: z.boolean(),
  confirmationFlow: Flow.nullable().optional(),
}).strict()

interface LineRow {
  id: string; display_name: string; phone_number: string | null; line_type: string
  owner_user_id: string | null; brand_name: string | null; enabled: boolean | null
}

async function accessibleLines(user: Parameters<typeof getAccessibleLineIds>[0]) {
  const ids = await getAccessibleLineIds(user)
  return query<LineRow>(`
    SELECT l.id,COALESCE(l.display_name,l.line_key) AS display_name,l.line_type,l.owner_user_id,
      COALESCE(NULLIF(cn.display_phone,''),l.phone_number) AS phone_number,s.brand_name,s.enabled
    FROM whatsapp_lines l
    LEFT JOIN cloud_numbers cn ON cn.whatsapp_line_id=l.id
    LEFT JOIN whatsapp_subscription_settings s ON s.line_id=l.id
    WHERE ($1::uuid[] IS NULL OR l.id=ANY($1::uuid[]))
    ORDER BY l.display_name NULLS LAST,l.id`, [ids])
}

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'lines', 'read')
  if (!auth.ok) return auth.response
  const lineId = req.nextUrl.searchParams.get('lineId')
  const page = Number(req.nextUrl.searchParams.get('page') ?? '0')
  const view = req.nextUrl.searchParams.get('view') ?? 'all'
  if ((lineId && !Id.safeParse(lineId).success) || !Number.isInteger(page) || page < 0 || page > 100000
    || !['all','subscribed','unsubscribed','pending','renewal_required','history'].includes(view)) {
    return NextResponse.json({ error: 'Filtro inválido.' }, { status: 400 })
  }
  try {
    const lines = await accessibleLines(auth.user)
    const publicLines = lines.map(({owner_user_id,...line}) => ({...line,
      can_edit: auth.user.role === 'admin' || !!auth.user.is_super_admin || owner_user_id === auth.user.user_id,
    }))
    if (!lineId) return NextResponse.json({ lines: publicLines }, { headers: {'Cache-Control':'no-store'} })
    const line = publicLines.find(l => l.id === lineId)
    if (!line) return NextResponse.json({ error: 'Línea no encontrada.' }, { status: 404 })
    const [settingsRows, statsRows, records] = await Promise.all([
      query<SubscriptionSettings>('SELECT * FROM whatsapp_subscription_settings WHERE line_id=$1', [lineId]),
      query<{subscribed:number;unsubscribed:number;pending:number;renewal_required:number}>(`SELECT
        COUNT(*) FILTER(WHERE c.status='subscribed' AND e.revision=s.revision)::int AS subscribed,
        COUNT(*) FILTER(WHERE c.status='unsubscribed')::int AS unsubscribed,
        COUNT(*) FILTER(WHERE c.status='pending' AND e.revision=s.revision)::int AS pending,
        COUNT(*) FILTER(WHERE c.status IN ('pending','subscribed') AND e.revision<>s.revision)::int AS renewal_required
        FROM whatsapp_line_subscribers c
        JOIN whatsapp_subscription_events e ON e.id=c.event_id
        JOIN whatsapp_subscription_settings s ON s.line_id=c.line_id WHERE c.line_id=$1`, [lineId]),
      view === 'history'
        ? query(`SELECT id,contact_phone,event AS status,message_text,expected_message,brand_name,provider,message_id,occurred_at,recorded_at,request_event_id
            FROM whatsapp_subscription_events WHERE line_id=$1
            ORDER BY occurred_at DESC,id DESC LIMIT 51 OFFSET $2`, [lineId,page*50])
        : query(`SELECT e.id,c.contact_phone,
              CASE WHEN c.status IN ('pending','subscribed') AND e.revision<>s.revision THEN 'renewal_required' ELSE c.status END AS status,
              e.message_text,e.expected_message,e.brand_name,e.provider,e.message_id,c.occurred_at,e.recorded_at,e.request_event_id
            FROM whatsapp_line_subscribers c JOIN whatsapp_subscription_events e ON e.id=c.event_id
            JOIN whatsapp_subscription_settings s ON s.line_id=c.line_id
            WHERE c.line_id=$1 AND ($2='all' OR
              CASE WHEN c.status IN ('pending','subscribed') AND e.revision<>s.revision THEN 'renewal_required' ELSE c.status END=$2)
            ORDER BY c.occurred_at DESC,c.contact_phone LIMIT 51 OFFSET $3`, [lineId,view,page*50]),
    ])
    const settings = settingsRows[0] ?? null
    return NextResponse.json({ lines: publicLines, line, settings, stats: statsRows[0],
      link: settings?.enabled ? subscriptionLink(line.phone_number ?? '',settings.message_text) : null,
      records: records.slice(0,50), hasMore: records.length > 50, page,
    }, {headers:{'Cache-Control':'no-store'}})
  } catch {
    return NextResponse.json({ error: 'No se pudieron cargar las suscripciones.' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'lines', 'update')
  if (!auth.ok) return auth.response
  const parsed = Settings.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({error:'Revisá la línea, la marca y el mensaje.'},{status:400})
  const {lineId,brandName,message,enabled,confirmationFlow} = parsed.data
  const error = subscriptionMessageError(brandName,message)
  if (error) return NextResponse.json({error},{status:400})
  try {
    const line = (await accessibleLines(auth.user)).find(l => l.id === lineId)
    if (!line) return NextResponse.json({error:'Línea no encontrada.'},{status:404})
    if (confirmationFlow && (line.line_type !== 'cloud' || !/\bOK\b/i.test(confirmationFlow.welcome)
      || !/\bBAJA\b/i.test(confirmationFlow.confirmation))) {
      return NextResponse.json({error:'La confirmación en dos pasos requiere Cloud API, OK en la bienvenida y BAJA en la confirmación.'},{status:400})
    }
    if (auth.user.role !== 'admin' && !auth.user.is_super_admin && line.owner_user_id !== auth.user.user_id)
      return NextResponse.json({error:'Solo podés configurar tus propias líneas.'},{status:403})
    const link = subscriptionLink(line.phone_number ?? '',message)
    if (enabled && !link) return NextResponse.json({error:'La línea necesita un número válido con código de país para generar el enlace.'},{status:400})
    const settings = await saveSubscriptionSettings(lineId,brandName,message,enabled,confirmationFlow)
    void audit({req,action:'update',resource:'lines',resource_id:lineId,
      metadata:{action:'subscription_settings',revision:settings.revision,enabled,confirmationRequired:!!settings.confirmation_flow}})
    return NextResponse.json({settings,link:enabled ? link : null})
  } catch {
    return NextResponse.json({error:'No se pudo guardar la configuración.'},{status:500})
  }
}
