# Plantillas por cuenta de WhatsApp

El catálogo se organiza por WABA, no por número ni por aplicación de Meta.
Las líneas de una misma cuenta comparten las plantillas aprobadas de esa cuenta.
La aprobación de Nexus no habilita una copia en Lexora.

## Uso

1. En **Plantillas**, elegir una cuenta o **Todas las cuentas**. La columna
   **Cuenta** identifica la propietaria, con los últimos dígitos de su ID para
   distinguir nombres repetidos.
2. **Nueva plantilla** requiere una cuenta conectada. Se guarda como borrador;
   el envío a revisión es una acción posterior.
3. **Copiar a otra cuenta** conserva los componentes y ejemplos, pero crea un
   borrador nuevo sin ID de Meta, aprobación, usos ni historial de campañas.
   Se puede conservar el nombre si no existe en el destino para ese idioma.
4. **Sincronizar desde Meta** actualiza la cuenta seleccionada, o todas las
   cuentas conectadas si no hay filtro. No crea plantillas en Meta ni envía mensajes.
5. En **Campañas**, filtrar las plantillas aprobadas por cuenta. Cambiar la cuenta
   borra la selección y sus parámetros. El distribuidor solo admite líneas de
   la misma WABA que la plantilla.

Las plantillas históricas sin WABA aparecen como **Sin cuenta asignada**. No se
asignan ni eliminan automáticamente. Se pueden copiar a una cuenta y solicitar
una aprobación nueva; sincronizar importa las aprobaciones reales de Meta.

Las plantillas enviadas se consultan en modo lectura. Para modificarlas se usa
Meta y luego se sincroniza. Los componentes que exceden las capacidades del
editor local también se conservan en modo lectura, evitando una edición que
elimine opciones. Los ejemplos multimedia copiados pueden requerir una nueva
carga válida para la aplicación de destino antes de que Meta acepte la revisión.

## Garantías técnicas

- No hay cambios de esquema ni reasignaciones masivas. Se usa el índice existente
  por `(waba_id, name, language)` de la migración 131.
- Crear, copiar, enviar y sincronizar comprueban acceso a las líneas de la cuenta.
  Las llamadas a Meta usan el token cifrado de una línea de esa WABA; no recurren
  a las credenciales globales de otra integración.
- La copia inserta un registro nuevo; nunca actualiza la plantilla original.
- Los estados aprobados solo se obtienen desde Meta. El editor no permite
  modificar el estado ni mover una plantilla a otra cuenta.
- El envío bloquea la fila contra solicitudes simultáneas. Si Meta ya tiene el
  mismo nombre e idioma, se pide sincronizar antes de reintentar.
- Las fallas de sincronización conservan el catálogo anterior de la cuenta
  afectada. Los borradores locales no se deshabilitan por faltar en Meta.

## Verificación

Las pruebas de rutas cubren permisos, filtros, copia íntegra, conflictos de
nombres, estados y selección de credenciales. Las pruebas de interfaz comprueban
el filtro, la copia y el reinicio de parámetros al cambiar de cuenta en Campañas.
`template-accounts-postgres.test.ts` usa tablas temporales en PostgreSQL local
para comprobar aislamiento y conservación del original. Se ejecuta con
`CONTACTS_TEST_DATABASE_URL`; la validación oficial de publicaciones lo incluye.
`template-storage-postgres.test.ts` verifica además los esquemas histórico y
moderno con `RUN_TEMPLATE_PG_TESTS=1` y `DATABASE_URL` local.
