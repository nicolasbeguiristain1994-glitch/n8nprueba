# Seguridad: dependencias, conexiones y funciones internas

Este cambio parte de la versión publicada `c8d1033af6c505c6e8e62be638f40b6d73b1abf2`.
Conserva los cambios recientes de filtros y confirmación de BAJA.

## Alcance

- Next.js 16.4.0, Sharp 0.35.5, fflate 0.8.3 y SheetJS 0.20.3 oficial.
  Se conservan Node 20 y el cliente Supabase 2.103.0 compatible con ese runtime.
- Se retiran el CLI de shadcn y los paquetes Puppeteer: no los usa el código.
  Los estilos de shadcn se conservan localmente con su licencia MIT. Los conectores
  existentes siguen usando Playwright.
- Los dos lockfiles registran las resoluciones auditadas. GitHub Actions rechaza
  alertas de riesgo alto/crítico en dependencias de ejecución.
- La política compartida `frontend/lib/database-tls.js` exige certificados
  verificados para las conexiones remotas del panel, importadores, sincronización,
  migraciones y backups. Incluye las CA públicas de Supabase, permite `DB_SSL_CA`
  y evita que parámetros de la URL desactiven TLS. Localhost permite desarrollo
  sin SSL. El panel deja de registrar URLs de conexión.
- La migración 152 quita EXECUTE a PUBLIC, anon y authenticated exclusivamente
  sobre siete funciones internas identificadas. Conserva service_role y al
  propietario; los triggers de auditoría siguen ejecutándose. Es transaccional,
  comprueba el resultado y tolera módulos opcionales ausentes.

## Decisiones confirmadas por el propietario

Las tablas `Participantes`, `participantes_1000` y `participantes_duende` pertenecen
a otro sistema activo. No se modifican sus datos, políticas ni privilegios.
Cajero 1, Maca y Prueba 2 conservan acceso a todos los agentes. No se cambian roles,
asignaciones ni sesiones de los usuarios existentes.

## Validación

- Pruebas con PostgreSQL 17 local: RPC rechazados para anon/authenticated,
  ejecución permitida para service_role, triggers operativos, ACL de las tablas
  del otro sistema intactas y migración repetible.
- Pruebas del cliente pg para URLs que intentan desactivar TLS o cambiar el host,
  CA válida y configuración local/remota. Conexión de solo lectura al servidor
  real para verificar `TLSSocket.authorized` antes de publicar.
- Suite de conectores/importadores; validación completa del commit con el
  ejecutor de releases, TypeScript, compilación y CI.
- Después de publicar: comprobar commit público, ledger de migraciones, permisos
  efectivos de las siete funciones, módulos autenticados y rechazo sin sesión.
  No usar campañas ni envíos a personas como prueba.

## Limitaciones y seguimiento

La auditoría de herramientas de desarrollo raíz informa una vulnerabilidad
moderada de `sprintf-js` a través de `argparse`, `js-yaml` y Jest. No forma parte
del contenedor de ejecución (`npm ci --omit=dev`). No hay parche compatible
publicado para esa cadena; `npm audit fix --force` propone bajar Jest a una versión
mayor antigua. Se conserva la suite actual y se debe actualizar cuando exista
una solución compatible. No se afirma que toda la base compartida quede libre
de advertencias: las tablas del otro producto y otros avisos del asesor requieren
su propia revisión.

Documentación de referencia: [SSL de node-postgres](https://node-postgres.com/features/ssl),
[privilegios de funciones en Supabase](https://supabase.com/docs/guides/database/functions)
y [distribución oficial de SheetJS](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/).
