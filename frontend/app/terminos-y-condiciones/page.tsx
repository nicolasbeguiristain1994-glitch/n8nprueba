import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Términos y Condiciones — WA Platform',
}

const sections = [
  {
    title: '1. Aceptación de los términos',
    body: 'Al acceder y utilizar WA Platform, usted acepta estar vinculado por estos Términos y Condiciones. Si no está de acuerdo con alguna parte de estos términos, no podrá acceder al servicio.',
  },
  {
    title: '2. Descripción del servicio',
    body: 'WA Platform es una plataforma de automatización de mensajería WhatsApp Business que permite gestionar campañas, contactos y comunicaciones a través de la API de WhatsApp Business de Meta.',
  },
  {
    title: '3. Uso aceptable',
    body: 'Usted se compromete a utilizar la plataforma únicamente para fines lícitos y de conformidad con las Políticas de Uso de WhatsApp Business de Meta. Queda prohibido el envío de spam, contenido engañoso, ilegal o que viole los derechos de terceros.',
  },
  {
    title: '4. Cumplimiento con Meta / WhatsApp',
    body: 'El uso de esta plataforma implica el cumplimiento de los Términos de Servicio de WhatsApp Business, las Políticas Comerciales de Meta y cualquier normativa adicional que Meta pueda establecer. El incumplimiento puede resultar en la suspensión del acceso a la API.',
  },
  {
    title: '5. Responsabilidad del usuario',
    body: 'Usted es responsable de mantener la confidencialidad de sus credenciales de acceso y de todas las actividades que ocurran bajo su cuenta. Debe notificarnos inmediatamente ante cualquier uso no autorizado.',
  },
  {
    title: '6. Limitación de responsabilidad',
    body: 'WA Platform no será responsable por daños indirectos, incidentales, especiales o consecuentes que resulten del uso o la imposibilidad de uso del servicio, incluyendo interrupciones del servicio de WhatsApp/Meta.',
  },
  {
    title: '7. Modificaciones al servicio',
    body: 'Nos reservamos el derecho de modificar o discontinuar el servicio en cualquier momento, con o sin previo aviso. No seremos responsables ante usted ni ante terceros por dichas modificaciones.',
  },
  {
    title: '8. Modificaciones a los términos',
    body: 'Podemos revisar estos términos en cualquier momento. Los cambios entrarán en vigor al ser publicados en la plataforma. El uso continuado del servicio constituye la aceptación de los nuevos términos.',
  },
  {
    title: '9. Ley aplicable',
    body: 'Estos términos se regirán e interpretarán de acuerdo con las leyes aplicables en la jurisdicción donde opera el servicio.',
  },
  {
    title: '10. Contacto',
    body: 'Para consultas sobre estos términos, contáctenos a través del administrador de su cuenta en la plataforma.',
  },
]

export default function TerminosYCondicionesPage() {
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
            Términos y Condiciones
          </h1>
          <p className="text-sm text-muted-foreground">
            Última actualización: mayo 2026
          </p>
        </header>

        <p className="text-muted-foreground leading-relaxed mb-10">
          Estos Términos y Condiciones regulan el acceso y uso de WA Platform.
          Al utilizar nuestros servicios, usted confirma haber leído, entendido
          y aceptado los presentes términos en su totalidad.
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
            Para más información sobre las políticas de WhatsApp Business, visitá{' '}
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
