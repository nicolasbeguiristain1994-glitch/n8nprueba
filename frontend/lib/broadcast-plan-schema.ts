import { z } from 'zod'

export const BroadcastPlanOptionsSchema = z.object({
  platform:z.enum(['zeus','bet30','ganamos','argenbet']).optional(),agent:z.string().trim().min(1).max(50).optional(),
  valueTier:z.enum(['super_vip','vip_alto','vip_medio','vip','medio','bajo']).optional(),
  reactivationSegment:z.enum(['REACTIVACION_URGENTE','REACTIVACION_PRIORITARIA','REACTIVACION_ESTANDAR','REACTIVACION_FRIA_ALTO_VALOR','REACTIVACION_FRIA']).optional(),
  lineIds:z.array(z.string().uuid()).min(1).max(100).transform(ids => [...new Set(ids)]),
  messageType:z.enum(['template','text']),templateId:z.string().uuid().optional(),
  planDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  startTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('09:00'),
  endTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  reservePercent:z.number().int().min(0).max(50),maxContacts:z.number().int().min(1).max(5000),
}).strict().refine(v => v.messageType !== 'template' || !!v.templateId,{message:'Seleccioná una plantilla aprobada.'}).refine(v => v.startTime < v.endTime,{message:'La hora de cierre debe ser posterior a la hora de inicio.'})

