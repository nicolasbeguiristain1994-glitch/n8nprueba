import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import './globals.css'

const geist = Geist({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'WhatsApp Platform',
  description: 'Plataforma de automatización WhatsApp',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className="h-full">
      <body className={`${geist.className} bg-gray-50 text-gray-900 h-full`}>
        {children}
      </body>
    </html>
  )
}
