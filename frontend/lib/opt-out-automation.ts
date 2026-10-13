// Shared by the sender and the panel so the displayed reply is the actual one.
export const OPT_OUT_CONFIRMATION = 'Disculpá las molestias. Ya registramos tu baja y no vas a recibir más mensajes promocionales de nuestra parte.'

export const OPT_OUT_AUTOMATION = {
  id: 'system-baja-confirmation',
  name: 'BAJA — Confirmación de baja',
  description: 'Confirma la baja y excluye al contacto de campañas en todas las líneas.',
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
