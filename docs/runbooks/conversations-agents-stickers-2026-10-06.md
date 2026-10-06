# Conversaciones: agentes y stickers

El filtro por agente usa el campo `contacts.panel` normalizado, sobre los hilos accesibles al operador, antes de paginar. Las opciones y cantidades abarcan toda esa bandeja y se combinan con campaña y nivel. La lista y cabecera muestran una etiqueta junto al nivel: royal azul, ofizeus violeta, bigwin verde, betcoin ámbar, farabet rosa, lasvegas cian. Sin asignación se muestra Sin agente.

El selector de stickers acepta PNG/JPG/WebP (hasta 5 MB), convierte los estáticos a WebP 512×512 hasta 100 KB y permite WebP animado 512×512 hasta 500 KB. La preparación autenticada firma el contenido para el operador con vencimiento. Se previsualiza antes de enviar. El envío Cloud mantiene línea entrante, ventana de servicio, bajas y disponibilidad de línea; carga el archivo al endpoint de medios y envía el ID como tipo sticker. En Evolution se usa sendSticker con base64. La vista previa compacta se conserva en metadata del mensaje; no se necesitan credenciales de Storage ni cambios de esquema. No se reintenta automáticamente un envío incierto.

La edición de mensajes fue cancelada expresamente por el usuario y no está incluida. Tampoco se agregan mejoras no solicitadas.

Validaciones: filtros combinados y paginación PostgreSQL, etiquetas, conversión real de imágenes, firma/operador/caducidad, envío simulado por línea y controles de ventana/baja. Se comprobó la carga real de un WebP a Meta y su eliminación, sin enviar mensajes a clientes.
