import { NextResponse } from 'next/server'
import type { SessionUser } from '@/lib/auth'
import { getAccessibleLineIds } from '@/lib/line-visibility'
import { cloudNumberRepository } from './repositories/cloud-number.repository'
export async function cloudNumberAccess(user: SessionUser, phoneNumberId: string) {
  const number = await cloudNumberRepository.findByPhoneNumberId(phoneNumberId)
  if (!number) return NextResponse.json({ error: 'Número no encontrado' }, { status: 404 })
  const ids = await getAccessibleLineIds(user)
  if (ids !== null && (!number.whatsappLineId || !ids.includes(number.whatsappLineId))) return NextResponse.json({ error: 'Sin acceso a esta línea' }, { status: 403 })
  return null
}
