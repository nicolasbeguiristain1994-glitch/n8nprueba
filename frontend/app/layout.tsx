import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'WhatsApp Platform',
  description: 'Plataforma de automatización WhatsApp',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className="h-full">
      <body className="bg-gray-50 text-gray-900 h-full">
        {children}
      </body>
    </html>
  )
}
