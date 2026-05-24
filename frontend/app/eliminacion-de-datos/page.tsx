import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Eliminación de Datos — WA Platform',
}

export default function EliminacionDeDatosPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-3xl mx-auto px-6 py-16">

        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-10"
        >
          ← Volver a la plataforma
        </Link>

        <header className="mb-10">
          <h1 className="text-3xl font-semibold tracking-tight mb-3">
            Instrucciones para la Eliminación de Datos
          </h1>
          <p className="text-sm text-muted-foreground">
            Última actualización: mayo 2026
          </p>
        </header>

        <p className="text-muted-foreground leading-relaxed mb-10">
          De acuerdo con las políticas de Meta Platforms, Inc., los usuarios tienen
          derecho a solicitar la eliminación de sus datos personales asociados al
          uso de esta plataforma.
        </p>

        <div className="space-y-8">
          <section>
            <h2 className="text-base font-semibold mb-2">¿Qué datos almacenamos?</h2>
            <p className="text-muted-foreground leading-relaxed text-sm">
              Almacenamos únicamente la información necesaria para operar el servicio:
              número de teléfono, nombre del perfil de WhatsApp Business y los mensajes
              enviados/recibidos a través de nuestra plataforma.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2">Cómo solicitar la eliminación</h2>
            <p className="text-muted-foreground leading-relaxed text-sm">
              Para solicitar la eliminación de tus datos, contactá al administrador
              de tu cuenta en la plataforma. Una vez recibida la solicitud, procederemos
              a eliminar tus datos en un plazo máximo de 30 días hábiles.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2">Confirmación de eliminación</h2>
            <p className="text-muted-foreground leading-relaxed text-sm">
              Una vez procesada la solicitud, recibirás una confirmación. Los datos
              eliminados no pueden recuperarse.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2">Datos retenidos por obligación legal</h2>
            <p className="text-muted-foreground leading-relaxed text-sm">
              Ciertos datos pueden ser retenidos por el tiempo que exija la legislación
              aplicable (por ejemplo, registros de facturación). Estos se eliminarán
              al vencimiento del período legal obligatorio.
            </p>
          </section>
        </div>

        <div className="mt-12 pt-8 border-t border-border text-xs text-muted-foreground">
          <p>
            Para más información sobre cómo Meta maneja tus datos, visitá{' '}
            <a
              href="https://www.facebook.com/privacy/policy"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground transition-colors"
            >
              facebook.com/privacy/policy
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  )
}
