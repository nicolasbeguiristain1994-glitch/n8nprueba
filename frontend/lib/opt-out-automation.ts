// Default used until an administrator saves a reply in Automatizaciones.
export const OPT_OUT_CONFIRMATION = 'Disculpá las molestias. Ya registramos tu baja y no vas a recibir más mensajes promocionales de nuestra parte.'
export const OPT_OUT_MESSAGE_MAX_LENGTH = 4096
export const OPT_OUT_MESSAGE_SETTING = 'automation_baja_confirmation_message'

export const OPT_OUT_AUTOMATION = {
  id: 'system-baja-confirmation',
  name: 'BAJA — Confirmación de baja',
  description: 'Confirma la baja y excluye al contacto de las campañas del agente al que respondió, en todas sus líneas.',
  type: 'reply',
  trigger_type: 'keyword',
  trigger_config: { keywords: ['BAJA'] },
  action_config: { message: OPT_OUT_CONFIRMATION },
  is_active: true,
  system_managed: true,
  priority: 0,
  created_by: null,
  created_by_name: 'Sistema',
  created_at: null,
  updated_at: null,
}
