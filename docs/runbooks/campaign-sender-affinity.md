# Remitentes persistentes y cupos

Cada destino normalizado conserva su línea dentro del propietario de la campaña.
Agregar líneas no redistribuye contactos existentes. Los destinos nuevos se
reparten mediante el cursor persistente de rotación.

Una línea desconectada, deshabilitada, sin cupo o de otra WABA no se sustituye
automáticamente: sus contactos esperan. Sólo una asignación cuyo `line_id` quedó
en `NULL` por eliminación del remitente puede repararse al preparar una campaña.
Se busca primero el historial de envíos exitosos en líneas todavía existentes y
accesibles. Si no existe, se asigna una línea elegible para esa campaña. El bloqueo
por propietario y la clave por teléfono impiden asignaciones divergentes entre
campañas concurrentes. Los reintentos conservan la nueva asignación.

Las pruebas individuales y respuestas reservan cupo antes de llamar al proveedor.
La reserva inicia los vencimientos de una hora y 24 horas si faltan y no extiende
una ventana ya abierta. Un resultado incierto del proveedor conserva la reserva.
Antes de seleccionar líneas o enviar se reinician únicamente los cupos vencidos,
sin depender del cron externo ni de abrir la pantalla de Líneas.

Para reparar contadores históricos sin vencimiento, conservar el uso registrado
e inicializar los plazos desde la reparación. No borrar contadores para simular
capacidad disponible. Una reparación de asignaciones debe respaldar los punteros
afectados, limitarse al propietario y a remitentes eliminados, y conservar los
contactos, el historial y las asignaciones válidas. Si se libera un puntero sin
remitente, la siguiente campaña resolverá el historial y la WABA correspondiente.

Las regresiones con PostgreSQL local cubren distribución entre ocho líneas,
historial, aislamiento por propietario, reparación concurrente, cupos vencidos y
competencia por el último cupo. Los proveedores están simulados: no envían mensajes.
