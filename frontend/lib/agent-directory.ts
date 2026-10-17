import { z } from 'zod'
import { appLog } from './security-log'
import { validAgentLink } from './agent-line-types'

export const AgentCodeSchema = z.string().trim().toLowerCase().min(1).max(100)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Usá letras sin espacios, números, guiones o guion bajo')
export const AgentNameSchema = z.object({ name: z.string().trim().min(1, 'Ingresá un nombre').max(100) }).strict()
export const NewAgentSchema = AgentNameSchema.extend({ code: AgentCodeSchema })
export const AgentDeliverySchema = z.object({ delivery_mode: z.enum(['phone', 'link']) }).strict()
const AgentLineFields = z.object({
  label: z.string().trim().min(1, 'Ingresá un nombre para la línea').max(100),
  phone: z.string().trim().max(40).nullable().transform(value => {
    const compact = (value || '').replace(/[\s().|\-]/g, '')
    return /^549\d{10}$/.test(compact) ? '+' + compact : compact || null
  }).pipe(z.string().regex(/^\+[1-9][0-9]{7,14}$/, 'Ingresá el teléfono completo con código de país, por ejemplo 549 | 1123 | 456789').nullable()),
  link_url: z.string().trim().max(2048).nullable().transform(value => value || null)
    .refine(value => value === null || validAgentLink(value), 'Ingresá un link completo que empiece con https:// o http://, sin espacios ni credenciales').optional(),
  is_active: z.boolean(),
}).strict()
const hasDestination = (data: {phone: string | null; link_url?: string | null}) => !!(data.phone || data.link_url)
const destinationError = {message: 'Cargá un teléfono o un link para esta línea'}
export const AgentLineDetailsSchema = AgentLineFields.refine(hasDestination, destinationError)
export const NewAgentLineSchema = AgentLineFields.extend({
  linea: z.number().int().min(1).max(100),
  variant: z.enum(['', 'a', 'b', 'c']),
}).refine(hasDestination, destinationError)
export function directoryError(error: unknown): Response {
  if (error instanceof Response) return error
  if ((error as {code?: string})?.code === '23505')
    return Response.json({ error: 'Ya existe ese agente o esa combinación de línea y variante. Editá el registro existente.' }, { status: 409 })
  if ((error as {code?: string})?.code === '23503')
    return Response.json({ error: 'El agente no existe. Actualizá la página.' }, { status: 404 })
  appLog('ERROR', 'agent directory failed', { error: error instanceof Error ? error.message : 'unknown' })
  return Response.json({ error: 'No se pudieron guardar o consultar las líneas. Reintentá.' }, { status: 500 })
}
export async function directoryBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  const result = schema.safeParse(await req.json().catch(() => null))
  if (!result.success) throw Response.json({ error: result.error.issues[0]?.message || 'Datos inválidos' }, { status: 400 })
  return result.data
}
export function requireAgentCode(code: string): string {
  const parsed = AgentCodeSchema.safeParse(code)
  if (!parsed.success || parsed.data !== code) throw Response.json({ error: 'Agente inválido' }, { status: 400 })
  return parsed.data
}
