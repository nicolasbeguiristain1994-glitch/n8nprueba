'use client'

import { useState, useEffect, useCallback } from 'react'

// ─── Tipos del resultado del Embedded Signup ──────────────────────────────────
interface SignupResult {
  authResponse?: {
    code:            string
    waba_id:         string
    phone_number_id: string
  } | null
  status: string
}

interface OnboardResult {
  cloudNumberId: string
  phoneNumberId: string
  displayPhone:  string
  status:        string
  message:       string
}

// ─── Declaración global del SDK de Facebook ───────────────────────────────────
declare global {
  interface Window {
    FB: {
      init: (config: Record<string, unknown>) => void
      login: (callback: (res: SignupResult) => void, options: Record<string, unknown>) => void
    }
    fbAsyncInit?: () => void
  }
}

export default function CloudOnboardPage() {
  const [sdkReady,  setSdkReady]  = useState(false)
  const [loading,   setLoading]   = useState(false)
  const [result,    setResult]    = useState<OnboardResult | null>(null)
  const [error,     setError]     = useState<string | null>(null)
  const [lineId,    setLineId]    = useState('')

  // ── Cargar el SDK de Facebook ─────────────────────────────────────────────
  useEffect(() => {
    const appId = process.env.NEXT_PUBLIC_META_APP_ID
    if (!appId) {
      setError('NEXT_PUBLIC_META_APP_ID no está configurado en las variables de entorno')
      return
    }

    if (document.getElementById('fb-sdk')) {
      setSdkReady(true)
      return
    }

    window.fbAsyncInit = function () {
      window.FB.init({
        appId,
        autoLogAppEvents: true,
        xfbml:            true,
        version:          'v21.0',
      })
      setSdkReady(true)
    }

    const script    = document.createElement('script')
    script.id       = 'fb-sdk'
    script.src      = 'https://connect.facebook.net/es_LA/sdk.js'
    script.async    = true
    script.defer    = true
    document.head.appendChild(script)
  }, [])

  // ── Iniciar el flujo de Embedded Signup con Coexistence ───────────────────
  const startEmbeddedSignup = useCallback(() => {
    if (!sdkReady) return
    setError(null)
    setLoading(true)

    window.FB.login(
      async (response: SignupResult) => {
        if (response.status !== 'connected' || !response.authResponse?.code) {
          setError('El usuario canceló el proceso o hubo un error de autorización')
          setLoading(false)
          return
        }

        const { code, waba_id, phone_number_id } = response.authResponse

        try {
          const res = await fetch('/api/cloud/onboard', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
              code,
              wabaId:        waba_id,
              phoneNumberId: phone_number_id,
              whatsappLineId: lineId || undefined,
            }),
          })

          const data: OnboardResult & { error?: string } = await res.json()

          if (!res.ok || data.error) {
            setError(data.error ?? 'Error al procesar el onboarding')
          } else {
            setResult(data)
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Error de red')
        } finally {
          setLoading(false)
        }
      },
      {
        config_id:      process.env.NEXT_PUBLIC_META_CONFIG_ID,
        response_type:  'code',
        override_default_response_type: true,
        // CRÍTICO: featureType = 'whatsapp_business_app_onboarding' activa Coexistence
        extras: {
          feature:     'whatsapp_embedded_signup',
          featureType: 'whatsapp_business_app_onboarding',
          setup:       {},
          sessionInfoVersion: 3,
        },
      },
    )
  }, [sdkReady, lineId])

  return (
    <div className="max-w-2xl mx-auto py-10 px-4">
      <h1 className="text-2xl font-bold mb-2">Conectar número oficial de WhatsApp</h1>
      <p className="text-gray-500 mb-6 text-sm">
        Registra un número de WhatsApp Business en la API oficial de Meta.
        El número podrá seguir usando la{' '}
        <strong>WhatsApp Business App</strong> simultáneamente (Coexistence).
      </p>

      {/* Selección de línea existente (opcional) */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Línea existente a vincular (opcional)
        </label>
        <input
          type="text"
          placeholder="UUID de la línea en la plataforma"
          value={lineId}
          onChange={e => setLineId(e.target.value)}
          className="w-full border rounded-lg px-3 py-2 text-sm"
        />
      </div>

      {/* Botón principal */}
      {!result && (
        <button
          onClick={startEmbeddedSignup}
          disabled={!sdkReady || loading}
          className="w-full bg-green-600 text-white font-semibold py-3 rounded-xl
                     hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed
                     flex items-center justify-center gap-2"
        >
          {loading ? (
            <>
              <span className="animate-spin">⏳</span>
              Procesando...
            </>
          ) : !sdkReady ? (
            'Cargando SDK de Meta...'
          ) : (
            'Conectar con Meta Business'
          )}
        </button>
      )}

      {/* Error */}
      {error && (
        <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Éxito */}
      {result && (
        <div className="mt-6 space-y-4">
          <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
            <h2 className="font-semibold text-green-800 mb-2">Número registrado exitosamente</h2>
            <dl className="text-sm space-y-1">
              <div className="flex gap-2">
                <dt className="text-gray-500 w-32">Número:</dt>
                <dd className="font-mono font-medium">{result.displayPhone}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-gray-500 w-32">Estado:</dt>
                <dd>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                    result.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'
                  }`}>
                    {result.status}
                  </span>
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-sm text-gray-600">{result.message}</p>
          </div>

          {result.status === 'code_sent' && (
            <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
              <strong>Próximo paso:</strong> El cliente debe ingresar el código de verificación
              en su <strong>WhatsApp Business App</strong>. Una vez verificado, la sincronización
              de historial comenzará automáticamente (puede tardar hasta 15 minutos).
            </div>
          )}

          {result.status === 'active' && (
            <div className="p-4 bg-purple-50 border border-purple-200 rounded-lg text-sm text-purple-800">
              La sincronización de contactos e historial está en curso.
              Recibirás una notificación cuando complete (puede tardar hasta 30 minutos
              dependiendo del volumen de conversaciones).
            </div>
          )}

          <button
            onClick={() => { setResult(null); setError(null) }}
            className="text-sm text-gray-500 hover:text-gray-700 underline"
          >
            Conectar otro número
          </button>
        </div>
      )}

      {/* Información sobre Coexistence */}
      <div className="mt-10 p-4 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-600">
        <h3 className="font-semibold text-gray-800 mb-2">¿Qué es Coexistence?</h3>
        <ul className="space-y-1 list-disc list-inside">
          <li>El número puede usar la API oficial Y la app de WhatsApp Business <strong>al mismo tiempo</strong></li>
          <li>Los mensajes enviados desde la app aparecen en nuestra plataforma (sincronizados)</li>
          <li>Límite: 20 mensajes por segundo via API</li>
          <li>Historial de hasta 180 días se sincroniza automáticamente</li>
          <li>Cero riesgo de ban por método de envío</li>
        </ul>
      </div>
    </div>
  )
}
