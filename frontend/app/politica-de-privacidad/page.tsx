import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Política de Privacidad — WA Platform',
}

const sections = [
  {
    title: '1. Información que recopilamos',
    body: 'Recopilamos información que usted nos proporciona directamente, incluyendo datos de contacto, información de cuenta y comunicaciones realizadas a través de nuestra plataforma.',
  },
  {
    title: '2. Uso de la información',
    body: 'La información recopilada se utiliza exclusivamente para operar y mejorar nuestros servicios, gestionar su cuenta y cumplir con las obligaciones legales aplicables.',
  },
  {
    title: '3. Compartir información',
    body: 'No vendemos ni alquilamos su información personal a terceros. Podemos compartir información con proveedores de servicios que nos asisten en la operación de la plataforma, bajo estrictos acuerdos de confidencialidad.',
  },
  {
    title: '4. Integración con WhatsApp / Meta',
    body: 'Esta plataforma utiliza la API de WhatsApp Business de Meta. Al conectar su número de WhatsApp, acepta también las políticas de uso de Meta Platforms, Inc. Los mensajes enviados y recibidos se procesan conforme a los términos de Meta.',
  },
  {
    title: '5. Seguridad de los datos',
    body: 'Implementamos medidas técnicas y organizativas para proteger su información contra acceso no autorizado, pérdida o alteración.',
  },
  {
    title: '6. Sus derechos',
    body: 'Usted tiene derecho a acceder, rectificar o eliminar su información personal. Para ejercer estos derechos, contáctenos a través de los canales indicados en esta política.',
  },
  {
    title: '7. Cambios a esta política',
    body: 'Podemos actualizar esta política periódicamente. Le notificaremos cualquier cambio material mediante un aviso en la plataforma.',
  },
  {
    title: '8. Contacto',
    body: 'Para consultas relacionadas con esta política, contáctenos a través del administrador de su cuenta en la plataforma.',
  },
]

export default function PoliticaDePrivacidadPage() {
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
            Política de Privacidad
          </h1>
          <p className="text-sm text-muted-foreground">
            Última actualización: mayo 2026
          </p>
        </header>

        <p className="text-muted-foreground leading-relaxed mb-10">
          Esta Política de Privacidad describe cómo WA Platform recopila, usa y protege
          la información personal de los usuarios de nuestra plataforma de automatización
          de WhatsApp Business.
        </p>

        <div className="space-y-8">
          {sections.map(({ title, body }) => (
            <section key={title}>
              <h2 className="text-base font-semibold mb-2">{title}</h2>
              <p className="text-muted-foreground leading-relaxed text-sm">{body}</p>
            </section>
          ))}
        </div>

        <div className="mt-12 pt-8 border-t border-border text-xs text-muted-foreground">
          <p>
            Esta política cumple con los requisitos de la API de WhatsApp Business de Meta.
            Para más información sobre las políticas de Meta, visitá{' '}
            <a
              href="https://www.whatsapp.com/legal/business-policy"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground transition-colors"
            >
              whatsapp.com/legal/business-policy
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  )
}
