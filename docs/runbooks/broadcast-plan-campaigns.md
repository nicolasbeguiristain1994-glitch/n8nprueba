# Campañas desde Planificar difusión

En Prioridades, Planificar difusión conserva los filtros y propone contactos para hoy,
mañana o pasado mañana (hora Argentina). Las líneas se identifican por nombre y
terminación del número; se preseleccionan únicamente las compatibles con la plantilla
aprobada y su cuenta de WhatsApp, excluyendo alertas que detienen la recomendación.
El usuario puede quitar líneas. El cupo y la calidad
se vuelven a comprobar al calcular.

El resumen separa seleccionados, pendientes (capacidad, frecuencia o campañas en curso)
y excluidos (datos, consentimiento o elegibilidad). Cada motivo incluye una acción;
los detalles de cálculo y advertencias quedan desplegables.

Crear campaña con este plan abre el asistente en Contenido. El traslado se guarda
solo en sessionStorage, ligado al usuario: IDs de contactos, ajustes, líneas y huella,
sin nombres ni teléfonos de contactos. Se puede revisar, guardar un borrador o
programar dentro de la ventana elegida. Si posterga el inicio, se recalcula el cupo
para el tiempo que realmente queda. Ninguno de esos pasos envía una prueba.

Antes de guardar, el servidor recalcula con permisos y datos actuales. Compara IDs,
destinos y remitentes; si cambiaron, responde 409 con el plan actualizado y requiere
aceptación explícita en la interfaz. No confía en asignaciones proporcionadas por el
cliente. La creación, audiencia fija, destinatarios y remitentes se confirman en una
transacción, serializada por responsable. El UUID de solicitud y su hash evitan una
segunda campaña por doble clic o respuesta perdida. La cola conserva el orden de
prioridad del plan dentro de cada línea.

La migración 165 incorpora campaigns.broadcast_plan (opcional para campañas
anteriores). Solo el servidor lo escribe. Las restricciones se verifican en el claim y
justo antes del proveedor, además de los controles existentes de permisos,
consentimiento, frecuencia, cuotas, calidad y plantilla. El cierre no corta una
solicitud que el proveedor ya empezó a procesar. No se reserva cuota del proveedor.

Una campaña planificada que no terminó en su ventana, o que agotó el presupuesto de
una línea, queda pausada con broadcast_plan_review; no continúa automáticamente otro
día. Los pendientes siguen en esa campaña. Si la ventana terminó, cancelarla libera
los pendientes que sea seguro volver a planificar; los resultados inciertos conservan
las protecciones existentes. Una edición de horario debe quedar dentro de la ventana.
Las campañas anteriores mantienen su continuación automática al horario original.

Verificación: pruebas de asignación y agrupación, compatibilidad y traslado en interfaz,
aceptación explícita de cambios, creación/snapshot/idempotencia/permisos con PostgreSQL,
y barreras de destino/remitente/horario antes del proveedor. Los smoke tests de
producción permiten únicamente lectura y vistas previas; no crean campañas ni envíos.
