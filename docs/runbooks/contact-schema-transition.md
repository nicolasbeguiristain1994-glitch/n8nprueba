# Transición a cuentas por agente

La versión puente admite el modelo 1 y consulta `app_settings.contact_schema_required_version` (sin fila equivale a 1). Antes de aplicar la migración que cambia las claves únicas:

1. Publicar y verificar primero la versión puente con el ejecutor normal.
2. Verificar un respaldo restaurable y la migración en una copia local completa.
3. Confirmar que no haya campañas ni automatizaciones procesando. Guardar el valor previo del ajuste y establecerlo en 2 mediante una operación administrativa auditada.
4. Comprobar HTTP 503 con `SCHEMA_UPGRADE_IN_PROGRESS` en las API y esperar el drenaje de las solicitudes previas. El caché vence a los 2 segundos; esperar además al menos 90 segundos y verificar que no queden escrituras de la aplicación. Los webhooks reciben 503 para que el proveedor reintente. No iniciar campañas durante la transición.
5. Publicar la versión de cuentas por agente (admite modelo 2), mediante el mismo ejecutor con migración, CI y artefacto verificados.
6. Verificar el commit activo, las cuentas, las bajas, el historial y las API. El ajuste permanece en 2 para impedir que un contenedor antiguo vuelva a escribir.

Si falla antes de la migración, se puede restaurar el valor previo. Después de cambiar las claves, mantener el bloqueo hasta completar una versión compatible. `/login` y `/release.json` permanecen disponibles para salud e identidad; la pausa no modifica ni envía datos de clientes.
