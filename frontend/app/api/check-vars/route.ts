import { NextResponse } from 'next/server'

// Endpoint temporal de diagnóstico — expone solo true/false por var, nunca los valores.
// Eliminar luego de confirmar que el build contiene las variables correctas.
export async function GET() {
  return NextResponse.json({
    NEXT_PUBLIC_META_CONFIG_ID: !!process.env.NEXT_PUBLIC_META_CONFIG_ID,
    NEXT_PUBLIC_META_APP_ID:    !!process.env.NEXT_PUBLIC_META_APP_ID,
    META_APP_ID:                !!process.env.META_APP_ID,
    TOKEN_ENCRYPTION_KEY:       !!process.env.TOKEN_ENCRYPTION_KEY,
  })
}
