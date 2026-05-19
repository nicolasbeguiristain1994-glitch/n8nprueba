export function Footer() {
  return (
    <footer className="border-t border-border/50 mt-auto py-4 px-6">
      <div className="flex flex-col sm:flex-row items-center justify-center gap-x-6 gap-y-1 text-xs text-muted-foreground">
        <a
          href="/politica-de-privacidad"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground transition-colors"
          aria-label="Ver Política de Privacidad"
        >
          Política de Privacidad
        </a>
        <span className="hidden sm:inline select-none">·</span>
        <a
          href="/terminos-y-condiciones"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground transition-colors"
          aria-label="Ver Términos y Condiciones"
        >
          Términos y Condiciones
        </a>
      </div>
    </footer>
  )
}
