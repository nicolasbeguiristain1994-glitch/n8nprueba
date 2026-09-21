import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Encuesta — Contanos cómo la venís pasando',
  description: 'Ayudanos a mejorar en menos de un minuto.',
  robots: { index: false, follow: false },
}

/**
 * Layout público para /encuesta y /encuesta/gracias.
 *
 * Sin AppShell — se renderiza sin sidebar/topbar. Mobile-first, centrado,
 * padding generoso, con footer de compliance y "juega responsablemente".
 */
export default function EncuestaLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <main className="flex-1 flex flex-col items-center px-4 py-6 sm:py-10">
        <div className="w-full max-w-lg">{children}</div>
      </main>
      <footer className="py-4 px-4 text-center text-xs text-muted-foreground border-t border-border/40">
        Tu participación es <span className="font-medium">voluntaria</span> y las respuestas son anónimas.
        <br className="hidden sm:block" />
        <span className="mx-1">·</span>
        Recordá jugar de forma <span className="font-medium">responsable</span>. +18.
      </footer>
    </div>
  )
}
