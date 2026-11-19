// Shared browser/server helpers. Opening a link never records consent.
export function normalizeSubscriptionText(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('es')
}

export function subscriptionPhone(raw: string): string | null {
  const phone = raw.trim().replace(/[+\s().-]/g, '')
  return /^[1-9]\d{6,14}$/.test(phone) ? phone : null
}

export function subscriptionLink(phone: string, message: string): string | null {
  const number = subscriptionPhone(phone)
  return number && message.trim() ? `https://wa.me/${number}?text=${encodeURIComponent(message.trim())}` : null
}

export const SUBSCRIPTION_PRESETS = {
  clothing: 'Quiero recibir novedades y promociones de indumentaria de {marca} por WhatsApp, hasta 2 veces por semana. Puedo cancelar escribiendo BAJA.',
  solar: 'Quiero recibir información y promociones sobre energía solar de {marca} por WhatsApp, hasta 2 veces al mes. Puedo cancelar escribiendo BAJA.',
  general: 'Quiero recibir novedades y promociones de {marca} por WhatsApp. Puedo cancelar escribiendo BAJA.',
  withoutBrand: 'Quiero recibir novedades y promociones por WhatsApp. Puedo cancelar escribiendo BAJA.',
} as const

export function subscriptionMessageError(brand: string, message: string): string | null {
  const normalized = normalizeSubscriptionText(message)
  if (brand.trim().length < 2 || brand.trim().length > 100) return 'Ingresá una marca de entre 2 y 100 caracteres.'
  if (message.trim().length < 20 || message.trim().length > 1000) return 'El mensaje debe tener entre 20 y 1000 caracteres.'
  if (!/\bwhatsapp\b/.test(normalized) || !/\bbaja\b/.test(normalized)) return 'Incluí WhatsApp y la instrucción para cancelar escribiendo BAJA.'
  if (!/\b(quiero|acepto|autorizo|deseo)\b/.test(normalized) || !/\b(recibir|envío|envio)\b/.test(normalized)
    || /\bno\s+(quiero|acepto|autorizo|deseo)\b/.test(normalized)) return 'El texto debe expresar la aceptación de recibir mensajes.'
  if (/\{[^}]+\}/.test(message)) return 'Reemplazá los campos entre llaves antes de guardar.'
  return null
}

export function isSubscriptionStop(text: string): boolean {
  const normalized = normalizeSubscriptionText(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[.!¡¿?]+$/g, '').trim()
  return ['baja', 'stop', 'cancelar', 'salir', 'detener', 'no quiero', 'no me escribas', 'unsubscribe', 'opt out', 'optout'].includes(normalized)
}

export interface SubscriptionConfirmationFlow { welcome: string; confirmation: string; goodbye: string }

export function defaultSubscriptionFlow(brand: string): SubscriptionConfirmationFlow {
  return {
    welcome: `¡Hola, {{nombre}}! 😊 Para sumarte a nuestro programa de beneficios y recibir promociones de ${brand} por WhatsApp, respondé OK.`,
    confirmation: '¡Listo! 🎉 Ya sos parte de nuestro programa de beneficios. Si en algún momento querés dejar de recibir promociones, escribí BAJA.',
    goodbye: `Listo, te dimos de baja. Ya no vas a recibir promociones de ${brand} por WhatsApp.`,
  }
}

export function subscriptionWelcome(template: string, name: string | null): string {
  const cleanName = name?.replace(/[\r\n]+/g,' ').trim().slice(0,100)
  if (cleanName) return template.replace(/\{\{nombre\}\}/gi, () => cleanName)
  return template.replace(/¡Hola,\s*\{\{nombre\}\}!/gi,'¡Hola!').replace(/\{\{nombre\}\}/gi,'')
}

// Keep existing shared links usable with or without their final full stop.
export function normalizeSubscriptionRequest(text: string): string {
  return normalizeSubscriptionText(text).replace(/\.$/,'').trim()
}
