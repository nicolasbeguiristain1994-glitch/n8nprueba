# Bandejas y perfiles de agente

La campaña permite seleccionar el agente propietario. Sus mensajes y respuestas se muestran en esa bandeja. La atribución usa campaña, línea y mensaje citado antes de aplicar los permisos; un mismo teléfono puede participar en campañas de distintos agentes sin compartir sus mensajes, notas ni estado del CRM. Las campañas históricas quedan sin agente hasta que un administrador las asigna desde Campañas.

En Usuarios, «Aplicar perfil de agente» configura un operador con Conversaciones, Estadísticas y Calendario y un único agente. Los módulos siguen siendo editables. Un administrador mantiene acceso global; un viewer sólo puede leer. Los permisos se verifican en las API y se refrescan durante los eventos en vivo. Los cambios de agentes revocan sesiones existentes.

El perfil puede responder por la línea del hilo sin permisos de envío masivo ni acceso global a esa línea. Se conservan stickers, medios, reacciones, ventanas Cloud y protecciones de envío. Las estadísticas, detalle, CSV y herramientas de IA aplican el alcance de campaña aunque un administrador haya creado la campaña. El calendario tiene permiso independiente de Tareas y filtra contenido por agente.

Los operadores con Conversaciones comparten la bandeja «Sin agente», incluida en «Todos los agentes». Recibe los primeros mensajes entrantes con línea identificada, sin cuenta asignada ni historial de campaña para ese teléfono. Permite responder por la línea de origen y guardar el contacto sin asignarlo automáticamente a un agente. El contacto guardado sigue compartido; los contactos eliminados o con asignaciones privadas y los mensajes de campañas históricas no entran en esta bandeja. Los chats de agentes conservan sus permisos actuales.

## Publicación

La fuente parte del commit productivo `731579bfd927c834b72fba8bcb7767c9c8a11578`. Se conservan los cambios ajenos del checkout de desarrollo sin publicarlos.

La migración `162_agent_workspaces.sql` agrega columnas nullable, índices y estado por agente. El ejecutor controla la transacción. Conserva el acceso al calendario para usuarios que ya tenían Tareas. No reasigna campañas históricas ni modifica el estado del bot. La tabla nueva habilita RLS y revoca acceso a roles públicos. La aplicación anterior puede funcionar mientras se aplica.

Validar con `node scripts/ops/release.mjs validate`, incluyendo pruebas PostgreSQL de bandejas, medios, notas, estadísticas, calendario y migración repetible. El ejecutor exige CI del mismo commit, ascendencia respecto de producción y ausencia de migraciones pendientes. Comprobar `/release.json`, módulos afectados y permisos tras obtener SUCCESS. Recuperación de aplicación mediante un commit inverso validado; conservar la migración aditiva y los datos.

## Módulos autorizados por agente

En Usuarios, usar Operador o Viewer, seleccionar los agentes permitidos y marcar los módulos. El perfil rápido conserva Conversaciones, Estadísticas y Calendario; se puede ampliar con Dashboard, Contactos y segmentación, Prioridades, Campañas, Agentes y sus líneas, Líneas de WhatsApp, Tareas, Automatizaciones y Plantillas. Envío habilita las campañas masivas por separado. Admin conserva acceso general; la lista de agentes vacía conserva el perfil histórico sin restricción de agente.

- Dashboard exige un agente autorizado antes de consultar datos o cachés. Con varios agentes, se elige uno en el selector; sin selección usa el primero permitido. Los alias de cada plataforma corresponden al mismo agente.
- Campañas y estadísticas usan `campaigns.agent_key`, aunque las haya creado un administrador. Las campañas históricas sin agente deben asignarse desde administración. Las audiencias nuevas y dinámicas se limitan al agente de la campaña.
- Agentes y sus líneas permite al operador editar los destinos de su directorio. Líneas de WhatsApp conserva sus permisos explícitos de propiedad y asignación; no se deduce la propiedad a partir del nombre. Los controles generales de infraestructura siguen siendo administrativos.
- Prioridades tiene un permiso independiente; la migración 164 conserva este acceso para quienes ya tenían Contactos. Las difusiones de un perfil restringido deben tener un único agente y guardan su asignación.
- Automatizaciones permite crear y editar respuestas del agente seleccionado; las reglas globales, BAJA y flujos generales siguen en administración. El envío vuelve a comprobar el rol, el módulo y el agente del creador. Los registros guardan su agente al ocurrir; los históricos sin atribución se mantienen solo para administración.
- Plantillas consulta las cuentas de WhatsApp asignadas; oculta borradores sin cuenta ajenos y contadores globales. Usuarios y ajustes generales siguen siendo administrativos. Viewer solo consulta.

La migración 164 es compatible con la aplicación previa, conserva las políticas RLS existentes y no reenvía mensajes ni reasigna campañas. También elimina el acceso de superadministrador de usuarios que ya fueron cambiados a otro rol.
