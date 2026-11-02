# Bandejas y perfiles de agente

La campaña permite seleccionar el agente propietario. Sus mensajes y respuestas se muestran en esa bandeja. La atribución usa campaña, línea y mensaje citado antes de aplicar los permisos; un mismo teléfono puede participar en campañas de distintos agentes sin compartir sus mensajes, notas ni estado del CRM. Las campañas históricas quedan sin agente hasta que un administrador las asigna desde Campañas.

En Usuarios, «Aplicar perfil de agente» configura un operador con Conversaciones, Estadísticas y Calendario y un único agente. Los módulos siguen siendo editables. Un administrador mantiene acceso global; un viewer sólo puede leer. Los permisos se verifican en las API y se refrescan durante los eventos en vivo. Los cambios de agentes revocan sesiones existentes.

El perfil puede responder por la línea del hilo sin permisos de envío masivo ni acceso global a esa línea. Se conservan stickers, medios, reacciones, ventanas Cloud y protecciones de envío. Las estadísticas, detalle, CSV y herramientas de IA aplican el alcance de campaña aunque un administrador haya creado la campaña. El calendario tiene permiso independiente de Tareas y filtra contenido por agente.

## Publicación

La fuente parte del commit productivo `731579bfd927c834b72fba8bcb7767c9c8a11578`. Se conservan los cambios ajenos del checkout de desarrollo sin publicarlos.

La migración `162_agent_workspaces.sql` agrega columnas nullable, índices y estado por agente. El ejecutor controla la transacción. Conserva el acceso al calendario para usuarios que ya tenían Tareas. No reasigna campañas históricas ni modifica el estado del bot. La tabla nueva habilita RLS y revoca acceso a roles públicos. La aplicación anterior puede funcionar mientras se aplica.

Validar con `node scripts/ops/release.mjs validate`, incluyendo pruebas PostgreSQL de bandejas, medios, notas, estadísticas, calendario y migración repetible. El ejecutor exige CI del mismo commit, ascendencia respecto de producción y ausencia de migraciones pendientes. Comprobar `/release.json`, módulos afectados y permisos tras obtener SUCCESS. Recuperación de aplicación mediante un commit inverso validado; conservar la migración aditiva y los datos.
