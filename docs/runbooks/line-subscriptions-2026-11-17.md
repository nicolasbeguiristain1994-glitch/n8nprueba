# Suscripciones por línea — 17/11/2026

## Uso

En **Líneas → Suscripciones** (`/lines/subscriptions`): seleccionar una línea,
indicar la marca, elegir un ejemplo de indumentaria/energía solar/general o
escribir un mensaje personalizado, y guardar. El enlace `wa.me` se puede copiar
para estados, redes o sitios. Se genera con el teléfono de la línea, nunca con
el Phone Number ID de Meta. Los cambios sin guardar no generan un enlace activo.

El destinatario debe enviar el mensaje completo. Abrir el enlace, escribir
“Hola” o enviar una parte del texto no autoriza campañas. Se toleran cambios
de mayúsculas, espacios y representaciones Unicode equivalentes. No hay una
respuesta automática ni un envío a clientes al guardar la configuración.

Cloud API y Evolution procesan el mensaje entrante autenticado. Se conserva
línea, teléfono, mensaje recibido, texto aceptado, marca, revisión, proveedor,
ID del mensaje, fecha del proveedor y fecha de registro. Una BAJA se registra
como revocación para esa línea y continúa por el mecanismo existente de baja
general/por agente, con su confirmación automática configurada. Las líneas sin esta configuración conservan
su comportamiento anterior, incluidas sus reglas de blacklist.

La pantalla muestra estado actual, autorizados, bajas, pendientes de renovación
e historial de eventos, con paginación de 50 registros. Actualizar vuelve a
consultar los registros. La recepción automática requiere el webhook configurado.

## Condiciones y controles de envío

- La configuración y los registros respetan la visibilidad de líneas y el
  permiso `lines.read`; editar requiere `lines.update` y las mismas reglas de
  propiedad que la edición de líneas. Un operador no edita líneas compartidas.
- Desde que una línea tiene esta configuración, sus campañas/envíos rápidos
  requieren una autorización vigente **de esa línea**. No se modifican los
  consentimientos globales de `contacts` ni se da permiso a otras marcas.
- Cambiar marca o texto crea una revisión: las autorizaciones previas permanecen
  en el historial y figuran “Por renovar”. Hay que compartir el nuevo enlace.
  Los enlaces con el texto anterior ya no registran nuevas altas.
- Desactivar nuevas autorizaciones no desactiva BAJA ni la comprobación de
  consentimiento de los envíos.
- Las respuestas de conversaciones autenticadas y las automatizaciones de
  servicio no requieren autorización de marketing, pero sí respetan las bajas.
  Los envíos directos/encolados de plantillas Cloud aplican la comprobación.
- Una nueva autorización posterior permite volver a suscribirse. No levanta
  restricciones manuales, de política ni entradas existentes en la blacklist.
- No se reemplazan las comprobaciones de ventana de servicio, aprobación de
  plantillas, permisos, cuotas, estado de línea o frecuencia.
- No se crea ni se reanuda una campaña, ni se importa una lista, al recibir un alta.

## Consistencia

La evidencia y el estado vigente se guardan en una transacción. La baja general
se procesa después; si falla, el webhook se reintenta y deduplica la evidencia. Una restricción única evita duplicados de webhook. Un lock
por línea/destinatario y la fecha original evitan que un alta vieja revierta una
baja más reciente. En igualdad de fecha prevalece la baja. No se aceptan altas
anteriores a la configuración vigente ni sin fecha válida. Una BAJA con fecha
inválida se registra con la fecha de recepción, conservando el ID para deduplicar.

## Publicación y validación

La migración aditiva `db/migrations/166_line_subscriptions.sql` se aplica mediante
el ejecutor de publicaciones verificadas antes del frontend. No precarga
configuraciones ni autoriza destinatarios. Las tablas tienen RLS sin políticas
públicas; su acceso es exclusivamente mediante el servidor.

Seguir `docs/runbooks/verified-releases.md`: Node 20, PostgreSQL 17 local,
`release.mjs validate`, CI para el mismo commit, artefacto de Git, migraciones,
Railway y verificación de `/release.json`. La validación incluye la suite real
`line-subscriptions-postgres.test.ts`, además de interfaz, webhooks y envíos.

El módulo conserva las bajas generales y por agente: recibir una autorización
no reactiva automáticamente una entrada de Blacklist. La reactivación existente
requiere revisión y evidencia desde esa pantalla.

No se envían mensajes reales durante las pruebas de publicación. Verificar
`/lines/subscriptions`, el acceso autenticado a su API, la nueva migración y RLS
tras el despliegue. Cada línea debe guardar su propia marca y texto antes de
compartir su enlace; no activar líneas ni campañas como parte del despliegue.
