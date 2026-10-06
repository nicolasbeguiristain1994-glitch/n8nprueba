# Filtro de difusión de Contactos

Parte de producción `0b2b5dfc9d58e7a2254cfc57df4cf03cc6e1e48a` (deployment `e7fb6e5c-52e7-479b-914e-1b4ef0400c65`). El workspace original se conserva; los cambios se preparan en `codex/contact-broadcast-filter-20261006`.

En Contactos → Difusión se puede elegir **No difundidos** (predeterminado, últimos 7 días) o **Difundidos**, ajustar la cantidad de días o seleccionar dos fechas. Las fechas incluyen ambos días completos en Argentina; los últimos N días equivalen a N períodos de 24 horas hasta el momento de consulta. El filtro se aplica sólo al confirmar y se limpia desde el mismo control.

Se consideran mensajes salientes de campañas registrados como enviados, entregados o leídos. “Enviado” indica aceptación por el proveedor, no garantiza entrega. Se usa el teléfono normalizado para abarcar todas las líneas y contactos reimportados. Fallidos, pendientes, pruebas sin campaña y conversaciones individuales no cuentan. Destinatarios históricos sin registro de mensajes cuentan sólo si tienen estado enviado y hora de envío. Una reserva de frecuencia no prueba una difusión realizada. No se infieren difusiones externas ni marcas manuales de Prioridades.

“No difundidos” incluye contactos sin envíos registrados en ese período, incluso aquellos sin historial. El filtro no modifica consentimiento, estados, niveles ni bloqueos de frecuencia existentes. La selección refleja el momento de consulta; no es un bloqueo adicional ante envíos posteriores. Una lista dinámica vuelve a resolver los últimos N días al preparar una nueva campaña y mantiene la audiencia congelada al reintentar.

La misma condición se aplica al listado, conteo, seleccionar todos, descarga, acciones por filtros y listas dinámicas. Se mantienen permisos y visibilidad. El historial se consulta como conjunto de teléfonos, evitando una lectura de todo el historial por cada contacto. No requiere migraciones ni modificaciones de datos.

Validación: pruebas de interfaz, entrada inválida, límites temporales y zona horaria, ausencia de historial, fallos y pendientes, mensajes individuales, teléfonos normalizados, reintentos, destinatarios legacy y conservación del filtro en audiencias dinámicas. La publicación debe pasar el ejecutor de releases y CI del commit exacto; verificar identidad y API antes de darla por finalizada.
