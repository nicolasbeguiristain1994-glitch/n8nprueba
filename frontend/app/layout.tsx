import type { Metadata } from 'next'
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
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className="h-full" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap"
          rel="stylesheet"
        />
        <style>{`:root { --font-inter: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif; }`}</style>
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
