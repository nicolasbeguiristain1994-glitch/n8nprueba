import { z } from 'zod'
import { appLog } from './security-log'

export const AgentCodeSchema = z.string().trim().toLowerCase().min(1).max(100)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Usá letras sin espacios, números, guiones o guion bajo')
export const AgentNameSchema = z.object({ name: z.string().trim().min(1, 'Ingresá un nombre').max(100) }).strict()
export const NewAgentSchema = AgentNameSchema.extend({ code: AgentCodeSchema })
export const AgentLineDetailsSchema = z.object({
  label: z.string().trim().min(1, 'Ingresá un nombre para la línea').max(100),
  phone: z.string().trim().max(40).transform(value => value.replace(/[\s().-]/g, ''))
    .pipe(z.string().regex(/^\+[1-9][0-9]{7,14}$/, 'Ingresá el teléfono con + y código de país, por ejemplo +5491123456789')),
  is_active: z.boolean(),
}).strict()
export const NewAgentLineSchema = AgentLineDetailsSchema.extend({
  linea: z.number().int().min(1).max(100),
  variant: z.enum(['', 'a', 'b', 'c']),
})
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
