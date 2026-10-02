# WhatsApp Cloud API — preparación del panel

La conexión directa sigue el flujo del manual proporcionado para Meta, adaptado a este software. No requiere StringsCRM. No se compran cuentas, eliminan administradores ni realizan cambios en Business Manager automáticamente.

## Lo implementado

- `/lines/cloud-onboard`: conexión directa mediante App ID, WABA ID, Phone Number ID y token de usuario del sistema. Valida el token contra la aplicación, permisos de gestión y envío, expiración y pertenencia del número a la WABA. Registro opcional con PIN explícito de seis dígitos. Sólo activa números que Meta informa CONNECTED en CLOUD_API.
- Tokens cifrados en PostgreSQL; nunca devueltos al navegador ni almacenados en localStorage. Líneas nuevas con campañas deshabilitadas.
- `/lines/cloud-inbox`: bandeja, texto dentro de ventana de servicio y prueba manual de plantilla aprobada sin variables. Plantillas con variables siguen en Campañas.
- Webhook HMAC, persistencia antes de confirmar recepción, respuesta 503 ante fallos para permitir reintentos, idempotencia de mensajes entrantes y ventana basada en la hora original. Un eco saliente no abre la ventana.
- El error 131026 no se interpreta como una baja; STOP/BAJA sí bloquean futuros envíos. Estados de entrega también actualizan el registro de campañas/envío rápido.
- Permisos de línea en mensajes, números, plantillas, sincronización, verificación, bandeja y creación de inbox Chatwoot.
- Redis falla cerrado: si el límite distribuido no está disponible, el envío espera/falla en lugar de saltárselo. La cola requiere un worker explícitamente habilitado; no se activó ninguno.
- Embedded Signup conserva su flujo, maneja evento y código en cualquier orden, verifica activos y no declara activa una línea sólo por haber verificado el SMS.

## Configuración en Railway

Servicio `whatsapp-panel`, entorno `production`. La clave de cifrado y el token de webhook ya se generaron y guardaron como variables privadas. Redis reutiliza el servicio existente mediante referencia. Faltan los valores reales de META_APP_ID y META_APP_SECRET; no se inventaron ni recuperaron de otras cuentas.

- `META_APP_ID`: ID de la aplicación Meta que tiene WhatsApp.
- `META_APP_SECRET`: secreto de esa aplicación, sólo en las variables del servidor.
- `META_WEBHOOK_VERIFY_TOKEN`: secreto aleatorio elegido para verificar el webhook, mismo valor en Meta y Railway.
- `TOKEN_ENCRYPTION_KEY`: secreto aleatorio de al menos 32 caracteres, conservado fuera del repositorio. No rotarlo sin recifrar los tokens existentes.
- `REDIS_URL`: conexión a Redis accesible desde el servicio. Respetar TLS/contraseña si corresponde.
- `META_API_VERSION`: opcional, versión soportada de Graph API para la aplicación. El código conserva v21.0 como predeterminada; confirmar versión admitida en Meta antes de vincular.

No poner App Secret, tokens ni PIN en variables `NEXT_PUBLIC_*`. `NEXT_PUBLIC_META_CONFIG_ID` es sólo para Embedded Signup, no necesario en la conexión directa. Mantener `CLOUD_MESSAGE_WORKER_ENABLED` desactivado mientras no exista un worker comprobado.

## Vinculación del primer número

1. En Meta: aplicación con producto WhatsApp, WABA propia, permisos de administrador sobre los activos, número verificado por SMS/llamada y facturación configurada. Confirmar nombre visible/estado y permisos del token `whatsapp_business_management` y `whatsapp_business_messaging`.
2. Completar las variables de servidor anteriores. La pantalla de conexión muestra cuáles faltan sin revelar sus valores.
3. En el producto WhatsApp de la aplicación, configurar callback `https://whatsapp-panel-production-f768.up.railway.app/api/cloud/webhook`, mismo token de verificación y eventos `messages` y `message_template_status_update`. Coexistence requiere además configuración y elegibilidad específicas de Meta.
4. Abrir `/lines/cloud-onboard` y completar IDs y token. Si el número aún requiere registro Cloud API, marcar el registro e introducir el PIN de verificación en dos pasos (no el SMS).
5. Con un destinatario de prueba autorizado, enviar un mensaje entrante al número, verificar su recepción en la bandeja, responder y comprobar estados. Probar una plantilla aprobada fuera de la ventana de 24 horas. Ningún mensaje real fue enviado durante esta auditoría.
6. Habilitar campañas sólo después de validar ese recorrido y los permisos/opt-in correspondientes.

Las páginas públicas existentes son `/politica-de-privacidad`, `/terminos-y-condiciones` y `/eliminacion-de-datos`. El titular debe verificar su contenido y los datos de contacto antes de presentarlas a Meta.

## Base y validación

Migración aditiva `130_whatsapp_cloud_readiness.sql`: completa tablas faltantes y cifrado; conserva los datos existentes, activa RLS y admite repetición. Se comprobó primero dentro de una transacción revertida y luego se aplicó en producción. No había números Cloud registrados en la comprobación inicial.

No se puede certificar una conexión real, recepción, registro de número, permisos concedidos por Meta o entrega efectiva sin los activos y credenciales reales. Los tests de Meta utilizan respuestas simuladas; la migración se validó contra PostgreSQL real.
