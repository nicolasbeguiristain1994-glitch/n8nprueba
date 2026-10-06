# Favoritos de stickers y ventana Cloud

Base: producción `34222387ba216b8114fe5faf14b57cc6429c19fb` (incluye la corrección de elegibilidad de respuestas Cloud).

Los favoritos se guardan por usuario en `conversation_sticker_favorites`, hasta 24 stickers, con nombre y miniatura. Al seleccionarlos se entrega una nueva autorización de envío. Guardar o quitar favoritos no envía mensajes. Se conserva el archivo original, incluso animado; sólo la miniatura es estática. La tabla tiene RLS sin políticas públicas; las rutas autenticadas aplican siempre el usuario de la sesión. El bloqueo por usuario y las ranuras únicas limitan almacenamiento bajo concurrencia. No depende de Storage.

El indicador consulta la ventana de la misma línea Cloud entrante utilizada por las respuestas. Respeta visibilidad de contactos y líneas, muestra el tiempo restante con reloj del servidor, avisa en la última hora e indica plantilla aprobada cuando vence. Refresca cada 30 segundos y al volver a la pestaña; errores muestran estado desconocido. No cambia ni extiende ventanas y no habilita envíos por sí mismo.

Migración 144: crea exclusivamente la tabla de favoritos; no modifica contactos, mensajes ni datos existentes. La versión anterior puede seguir funcionando mientras se aplica. Validar en PostgreSQL local, staging y CI antes del ejecutor de publicaciones verificadas. Las pruebas de interfaz interceptan los envíos a clientes. La edición de mensajes permanece excluida.
