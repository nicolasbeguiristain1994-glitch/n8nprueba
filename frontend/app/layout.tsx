import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import { ThemeProvider } from '@/components/layout/ThemeProvider'
import './globals.css'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

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
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`h-full ${inter.variable}`} suppressHydrationWarning>
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
