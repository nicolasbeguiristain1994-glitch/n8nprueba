import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { ThemeProvider } from '@/components/layout/ThemeProvider'
import './globals.css'

export const metadata: Metadata = {
  title: 'WA Platform',
  description: 'Plataforma de automatización WhatsApp',
}

/**
 * RootLayout — layout raíz de la aplicación.
 *
 * - suppressHydrationWarning en <html> es requerido por next-themes para
 *   evitar el warning de mismatch cuando aplica la clase "dark" en el cliente.
 * - ThemeProvider con attribute="class" añade/quita la clase "dark" en <html>.
 * - defaultTheme="system" respeta la preferencia del sistema operativo.
 * - disableTransitionOnChange evita el flash de color al cambiar tema.
 *
 * Inter se carga via Google Fonts con preconnect para rendimiento óptimo.
 * next/font/google fue reemplazado por link tags porque la v16.2.3 tiene un
 * bug donde capsize-font-metrics.json no se incluye en el paquete publicado.
 *
 * El componente es async para leer el nonce CSP inyectado por el middleware
 * vía el header x-nonce. El nonce se aplica al <style> inline para reflejar
 * la política Content-Security-Policy en modo enforcement (Fase 2).
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? ''

  return (
    <html lang="es" className="h-full" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap"
          rel="stylesheet"
        />
        <style nonce={nonce}>{`:root { --font-inter: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif; }`}</style>
      </head>
      <body className="h-full antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}
