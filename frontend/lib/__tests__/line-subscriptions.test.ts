import { describe, expect, it } from 'vitest'
import { isSubscriptionStop, normalizeSubscriptionText, subscriptionLink, subscriptionMessageError, SUBSCRIPTION_PRESETS } from '@/lib/line-subscription-message'

describe('subscription links and messages', () => {
  it('encodes the exact message, including accents, ampersands and line breaks', () => {
    const text = 'Quiero recibir novedades de Sol & Luz ☀️\nPor WhatsApp. BAJA para salir.'
    const link = new URL(subscriptionLink('+54 9 (11) 1234-5678',text)!)
    expect(link.origin).toBe('https://wa.me')
    expect(link.pathname).toBe('/5491112345678')
    expect(link.searchParams.get('text')).toBe(text)
  })
  it('rejects invalid phones rather than generating a link to a different destination', () => {
    for (const phone of ['','123','005491112345678','123@s.whatsapp.net','+1234567890123456','javascript:123456789'])
      expect(subscriptionLink(phone,'Hola')).toBeNull()
  })
  it('only tolerates whitespace, case and canonical Unicode in consent matching', () => {
    expect(normalizeSubscriptionText('  QUIERO\n información  ')).toBe(normalizeSubscriptionText('Quiero información'))
    expect(normalizeSubscriptionText('No quiero recibir')).not.toBe(normalizeSubscriptionText('Quiero recibir'))
  })
  it('recognizes BAJA as a standalone instruction, not inside the opt-in copy', () => {
    for (const text of ['BAJA',' baja! ','Bája','STOP','No me escribas']) expect(isSubscriptionStop(text)).toBe(true)
    expect(isSubscriptionStop(SUBSCRIPTION_PRESETS.clothing)).toBe(false)
    expect(isSubscriptionStop('¿Cómo doy de baja un pedido?')).toBe(false)
  })
  it('allows consent without repeating the internal business name, while retaining acceptance and opt-out checks', () => {
    expect(subscriptionMessageError('Tienda',SUBSCRIPTION_PRESETS.clothing.replace('{marca}','Tienda'))).toBeNull()
    expect(subscriptionMessageError('Tienda','Hola')).toBeTruthy()
    expect(subscriptionMessageError('Commando BD','Quiero recibir promociones de tu Negocio por Whatsapp. Puedo cancelar escribiendo BAJA.')).toBeNull()
    expect(subscriptionMessageError('Tienda',SUBSCRIPTION_PRESETS.withoutBrand)).toBeNull()
    expect(subscriptionMessageError('Tienda','Quiero recibir promociones por WhatsApp.')).toBeTruthy()
    expect(subscriptionMessageError('Tienda','No quiero recibir mensajes de Tienda por WhatsApp. BAJA.')).toBeTruthy()
    expect(subscriptionMessageError('Tienda',SUBSCRIPTION_PRESETS.clothing)).toBeTruthy()
  })
})
