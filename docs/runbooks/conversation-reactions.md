# Reacciones en conversaciones

El botón de carita debajo de cada mensaje abre seis reacciones frecuentes y el
selector completo. Elegir el mismo emoji o pulsar nuestra reacción la quita.
Las reacciones del contacto se muestran por separado y no se pueden quitar
desde el panel.

`POST /api/conversations/reactions` exige lectura de conversaciones, permiso de
envío, visibilidad del contacto y de la línea original. El servidor resuelve el
mensaje y su línea; el cliente solo aporta el UUID del mensaje, un UUID único
de solicitud y el emoji. Nunca se usa la asignación actual del contacto como
sustituto de una línea histórica desconocida.

Cloud reutiliza las comprobaciones de ventana de 24 horas, baja global,
conexión, capacidad y límite de envíos de las respuestas manuales. También se
excluyen mensajes de más de 30 días, fallidos, pendientes y reacciones. Evolution
usa la instancia original y `fromMe` del mensaje objetivo. Los registros
históricos sin línea demostrable solo muestran el mensaje, sin botón de envío.

Los eventos usan los registros existentes: `cloud_messages` para los eventos
Cloud y `whatsapp_messages.metadata.kind=reaction` para envíos y eventos
Evolution. No se requiere migración ni se amplían permisos de la base.
La selección del evento vigente considera mensaje, contacto, línea y actor;
un retiro vacío elimina el emoji y un envío fallido conserva la reacción previa.
Meta puede omitir `emoji` al retirar una reacción recibida. Estos eventos no
generan una nueva burbuja, ventana de servicio, notificación de mensaje ni
automatización.

Se registra una solicitud pendiente antes de llamar al proveedor. La misma
solicitud no se envía dos veces. Un timeout queda pendiente de confirmación y
no se reintenta automáticamente. Los rechazos posteriores de WhatsApp se
reflejan en el mensaje original.

Validación: pruebas de componentes, envío y retiro, denegaciones de acceso,
consulta SQL real en PostgreSQL 17, duplicados, eventos fuera de orden, fallos y
resultado incierto. Proveedores simulados: no se enviaron reacciones de prueba a
contactos reales. Revisión visual con datos ficticios en escritorio y 390 px.

Referencias oficiales consultadas:

- [Meta: envío de reacciones](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/reaction-messages)
- [Meta: eventos de reacciones](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/reaction)
- [Evolution: Send Reaction](https://docs.evoapicloud.com/api-reference/message-controller/send-reaction)
