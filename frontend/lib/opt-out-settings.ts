import { query } from '@/lib/db'
import { OPT_OUT_AUTOMATION, OPT_OUT_MESSAGE_SETTING } from '@/lib/opt-out-automation'
import { OptOutMessageSchema } from '@/lib/schema'

type Setting = { value: unknown; updated_at: string }

function automationFromSetting(setting?: Setting) {
  const message = OptOutMessageSchema.safeParse(setting?.value)
  return {
    ...OPT_OUT_AUTOMATION,
    action_config: { message: message.success ? message.data : OPT_OUT_AUTOMATION.action_config.message },
    updated_at: setting?.updated_at ?? null,
  }
}

// Read directly: the editor and each new confirmation must see the same saved
// text, without the general settings cache's five-minute delay. DB failures
// propagate so a pending receipt can retry before any provider submission.
export async function getOptOutAutomation() {
  const rows = await query<Setting>('SELECT value, updated_at FROM app_settings WHERE key=$1', [OPT_OUT_MESSAGE_SETTING])
  return automationFromSetting(rows[0])
}

export async function saveOptOutMessage(message: string, userId: string) {
  const text = OptOutMessageSchema.parse(message)
  const rows = await query<Setting>(
    `INSERT INTO app_settings (key,value,type,description,updated_by)
     VALUES($1,$2::jsonb,'string','Respuesta automática a BAJA',$3)
     ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW(),updated_by=EXCLUDED.updated_by
     RETURNING value,updated_at`,
    [OPT_OUT_MESSAGE_SETTING, JSON.stringify(text), userId === 'bootstrap' ? null : userId],
  )
  return automationFromSetting(rows[0])
}
