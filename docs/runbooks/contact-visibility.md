# Visibilidad compartida de contactos y conversaciones

`frontend/lib/contact-visibility.ts` define el alcance utilizado por lecturas,
importaciones, ediciones, listas, prioridades y notificaciones:

- Los contactos eliminados no forman parte de la audiencia activa.
- Administradores acceden a todos los contactos activos.
- Para operadores y lectores, `allowed_agents` limita el agente principal.
  Una lista vacía conserva la política existente de no restringir por agente.
- Si existen asignaciones en `operator_contact_visibility`, se exige además una
  asignación al contacto. Si no existe ninguna, aplica solamente el alcance de
  agentes. No se interpreta la ausencia de asignaciones como cero contactos.
- Los permisos de acción se comprueban por separado: lectores no modifican
  notas, estados ni contactos; blacklist conserva su permiso administrativo.

Los cambios de agente y las altas deben dejar el contacto dentro del alcance del
actor. Las altas de un usuario con asignaciones explícitas reciben asignación en
la misma transacción; para usuarios sin asignaciones no se introduce la primera
fila, porque eso reduciría inesperadamente su audiencia.

Las importaciones rechazan el bloque completo si incluye contactos existentes
fuera del alcance, también en modo omitir. El prechequeo no devuelve sus agentes
ni nombres. La validación y el cambio ocurren dentro de la misma transacción;
los conflictos de actualización vuelven a verificar el alcance. La segmentación
sigue ejecutándose solamente sobre los contactos insertados o actualizados.

Las consultas de conversaciones usan la misma política de contactos y la
visibilidad de líneas para Cloud. Una copia de un mensaje Cloud en el registro
legacy no permite eludir el permiso de línea. Los teléfonos Cloud aún sin
contacto se ven por sus líneas autorizadas; los teléfonos legacy sin contacto
quedan reservados al administrador al no existir un vínculo verificable.
Si hay varias filas del mismo teléfono, una fila oculta o eliminada bloquea la
conversación para evitar exponerla mediante un alias visible.

Las notificaciones consultan el usuario activo y sus permisos actuales. La misma
regla se aplica al generarlas, leerlas, contarlas y marcarlas como leídas. Un aviso
antiguo deja de mostrar su cuerpo si se revoca el acceso a su recurso. SSE comprueba
sesión y audiencia antes de emitir un teléfono; su consulta periódica se limita a
mensajes visibles y cierra la conexión al revocar la sesión o el sector.

Las listas guardadas mantienen su propietario y muestran el recuento de contactos
actualmente visibles. Las selecciones explícitas fuera del alcance se rechazan;
los filtros y divisiones trabajan con la audiencia visible. Al iniciar o reanudar
una campaña se comprueba también que su lista no contenga contactos fuera del
alcance. Los destinatarios históricos aplican el filtro en todos sus caminos de
consulta. Los envíos manuales validan el bloque completo antes de contactar un
proveedor.

## Verificación

`npm run release:validate` requiere `OPS_TEST_DATABASE_URL` local y ejecuta las
pruebas de migraciones, visibilidad en PostgreSQL, importación/segmentación,
conversaciones Cloud, SSE, permisos de sesión, tipos y compilación. Los fixtures
usan bases, esquemas o tablas temporales propios; no se borran contactos reales
ni se envían mensajes. La prueba real de visibilidad está en
`frontend/lib/__tests__/visibility-parity-postgres.test.ts`.

Para publicar se sigue [el procedimiento de versiones verificadas](verified-releases.md).
