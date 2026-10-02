# Envíos de prueba de campañas

La acción **Enviar prueba** aparece en el detalle de campañas guardadas con plantilla de Meta, únicamente para administradores. Permite registrar un número propio o del equipo (nombre y teléfono E.164), elegir una línea habilitada de la WABA de la plantilla y enviar una copia personalizada a ese número. Registrar un número no envía ningún mensaje.

## Activación

1. Aplicar `db/migrations/136_campaign_test_sends.sql` en la misma base del panel antes del despliegue. Es aditiva y repetible; no modifica contactos ni campañas existentes.
2. Publicar el frontend/API actualizado con esa migración aplicada.
3. Abrir el detalle de una campaña con plantilla aprobada, pulsar **Enviar prueba** y registrar el número de prueba. No hay destinatarios habilitados automáticamente.

La administración de números usa `POST`/`DELETE /api/campaign-test-recipients`. Quitar un número lo desactiva y conserva sus intentos anteriores. El detalle/historial y el envío usan `GET`/`POST /api/campaigns/[id]/test-send`; ambas rutas requieren administrador con gestión de campañas, y el envío también verifica el permiso de enviar.

## Comportamiento

- Omite solamente la evaluación de frecuencia del contacto para esta acción. Las campañas normales siguen usando sus límites habituales.
- Mantiene listas de bloqueo, bajas, plantilla aprobada, WABA, estado de línea, cupos de línea y rate limit de Meta. Los intentos que alcanzan el proveedor reservan cupo de línea antes del envío, incluso si la respuesta posterior es un error o no se puede confirmar.
- Personaliza con el nombre guardado del destinatario de prueba usando el mismo constructor de plantillas que las campañas.
- Escribe un intento durable antes de contactar a Meta. Cada solicitud lleva un UUID; repetirlo devuelve el intento existente. Hay exclusión mutua por destinatario, diez segundos entre pruebas y bloqueo de intentos en procesamiento durante dos minutos.
- Si se pierde la respuesta HTTP, el panel conserva el UUID y ofrece consultar/reintentar la misma solicitud. No hay reintentos automáticos al proveedor. Una prueba nueva solicitada expresamente después del intervalo usa otro UUID y conserva todos los intentos anteriores. Ante un resultado incierto, revisar el WhatsApp destinatario antes de pedir otra prueba.
- `Aceptado por Meta` no asegura entrega: este historial registra la aceptación, el fallo o un resultado sin confirmar. La entrega de la prueba se verifica en el número destinatario.
- No escribe ni elimina `contact_send_history`, no reinicia `campaign_recipients` ni modifica las métricas o el estado de la campaña.
- La acción anterior **Limpiar (pruebas)** se llama ahora **Reiniciar no enviados** y solo se habilita para administradores cuando la campaña está detenida y sin procesador activo.

## Validación

Los tests de rutas verifican permisos, datos inválidos y rechazo de destinatarios arbitrarios. Los tests de interfaz cubren registro sin envío, doble clic y reutilización del UUID tras una respuesta perdida. Los tests de PostgreSQL usan un esquema temporal exclusivo en localhost, validan la migración dos veces y prueban concurrencia, personalización, bloqueos, errores y conservación de registros. El proveedor está simulado: las pruebas automatizadas no envían WhatsApps.

Ejecutar desde `frontend`: `node node_modules/vitest/vitest.mjs run lib/__tests__/campaign-test-routes.test.ts components/campaigns/__tests__/CampaignTestSend.test.tsx components/campaigns/__tests__/campaigns-page.test.tsx lib/__tests__/campaign-distributor-cloud-readiness.test.ts lib/__tests__/campaign-distributor.test.ts`.

Para la suite SQL, establecer `RUN_CAMPAIGN_PG_TESTS=1` y `DATABASE_URL` a PostgreSQL local y ejecutar `node node_modules/vitest/vitest.mjs run lib/__tests__/campaign-test-sends-postgres.test.ts`. La suite rechaza servidores remotos y elimina su esquema temporal al terminar.
