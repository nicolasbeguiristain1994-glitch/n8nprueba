import { redirect } from 'next/navigation'
import { getSessionFromCookies } from '@/lib/auth'
import { AppShell } from '@/components/layout/AppShell'
import { ContentArea } from '@/components/layout/ContentArea'

/**
 * ProtectedLayout — layout para todas las rutas autenticadas.
 *
 * Responsabilidades:
 *   1. Verificar sesión en el servidor → redirect a /login si no hay sesión.
 *   2. Montar AppShell (sidebar + topbar + mobile nav).
 *   3. Envolver el contenido con ContentArea (padding consistente).
 *
 * Si una página necesita layout full-bleed (sin padding), puede importar
 * ContentArea directamente con noPadding:
 *   <ContentArea noPadding>{...}</ContentArea>
 * y el layout no interferirá porque la página controlaría su propio espaciado.
 */
export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionFromCookies()
  if (!session) redirect('/login')

  return (
    <AppShell>
      <ContentArea>
        {children}
      </ContentArea>
    </AppShell>
  )
}
