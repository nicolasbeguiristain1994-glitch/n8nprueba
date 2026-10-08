# Usuarios sin número

Implementación en el módulo Contactos, pestaña **Usuarios sin número**.

## Uso

1. El período inicial es **últimos 6 meses**, ajustable a 1, 3, 12, 24 meses o todo el historial. Se puede filtrar por agente canónico, plataforma y usuario.
2. **Descargar para agentes** exporta todos los resultados filtrados, no sólo la página visible, en Excel. Conserva Usuario, Plataforma y Agente; incluye Nombre opcional y Celular vacío como texto.
3. El agente completa Celular con código internacional, por ejemplo `+5491123456789`. Puede devolver XLSX, XLS o CSV con las mismas columnas.
4. **Cargar celulares** revisa el archivo y muestra cuentas válidas, vacías, repetidas y errores con el número de fila. Al confirmar, las cuentas válidas quedan vinculadas a Contactos y salen de pendientes. Las demás siguen pendientes.

La importación admite hasta 100.000 filas y 15 MB en la pantalla. La exportación no trunca resultados: si supera 100.000, pide acotar filtros. Varios usuarios o plataformas pueden compartir un celular; se crea un único contacto y se agregan sus cuentas explícitas. Reimportar una planilla no duplica contactos. Los conflictos de celular para una misma cuenta requieren revisión; no se reemplazan teléfonos existentes. Se conservan nombres, estados, preferencias, bloqueos y asignaciones de línea de los contactos existentes.

## Fuente y alcance

- La lista consulta los datos sincronizados de las cuatro plataformas mediante `casino_segmentation_players`, `casino_transactions` y los vínculos existentes de `casino_contact_account_links`.
- La identidad es plataforma + usuario. La coincidencia por nombre sólo se admite cuando la vista de vínculos ya la considera inequívoca.
- Los movimientos incluyen cargas y retiros. Los límites usan meses calendario y día de Argentina. Para perfiles históricos sin detalle se utiliza la última carga registrada en su resumen.
- **Incluir nuevos sin movimientos** incorpora perfiles insertados desde la activación cuyo primer registro local cae dentro del período. `first_seen_at` registra detección local, no fecha de alta en la plataforma. Los perfiles históricos quedan con fecha desconocida, no se presentan como recién creados.
- Un alta que la integración de la plataforma todavía no proporciona no puede aparecer. Los conectores actuales orientados a movimientos incorporan cuentas al detectar su actividad; este módulo no añade un nuevo recolector de altas sin actividad.
- La pestaña consulta al abrir, al recuperar el foco y cada minuto mientras está visible. No almacena otra lista de pendientes ni necesita un job adicional.
- La exportación conserva el permiso global y por usuario. Operadores necesitan agentes explícitamente asignados; los permisos limitados a contactos individuales no autorizan explorar cuentas nuevas sin contacto. El servidor aplica el alcance también a archivos importados.

## Activación

Aplicar `db/migrations/145_casino_players_first_seen.sql` con el ejecutor de releases antes de publicar el frontend. Es aditiva e idempotente: agrega una columna nullable y un default sólo para futuras inserciones, sin modificar perfiles históricos. Requiere las tablas y vistas de casino que ya consume la segmentación. El ejecutor administra la transacción.

La implementación y las pruebas son locales. Este cambio no publica el panel ni ejecuta migraciones sobre producción. El directorio de trabajo contiene otros cambios previos: una publicación debe aislar estos archivos para no incorporarlos incidentalmente.

La importación confirma todos los registros válidos en una transacción. Los errores de base revierten la operación; los errores de datos se informan por fila antes y después de confirmar. Un lock transaccional serializa importaciones de esta sección. El flujo no envía mensajes ni dispara campañas.

## Verificación

- Pruebas PostgreSQL con las vistas reales de la migración 126 vigente en producción y datos ficticios: movimientos, nuevas detecciones, límites del período, plataformas, aliases, permisos, vista previa sin escritura, importación idempotente, celulares compartidos, conflictos, concurrencia y rollback.
- Pruebas de rutas: autenticación, permisos de descarga, validación de importación y Excel de ida y vuelta.
- Pruebas de pantalla: seis meses por defecto, filtros, carga/revisión/confirmación y actualización de Contactos.
- Regresiones de carga de contactos, importador existente y filtros de actividad/plataforma.

Para ejecutar las pruebas PostgreSQL, usar `RUN_MISSING_CONTACTS_PG_TESTS=1` y `DATABASE_URL` apuntando exclusivamente a un PostgreSQL local de pruebas; la suite rechaza hosts remotos. Crea y elimina su propio esquema. Las pruebas restantes no requieren base.

Validación local del 08/10/2026: **40 pruebas aprobadas**, TypeScript sin errores y compilación Next.js 16.3.5 aprobada en una copia temporal aislada. Se revisó la pestaña en Chrome con datos ficticios a 1440 × 960 y 390 × 844: sin errores de página ni desborde horizontal del documento. Capturas y resultado del navegador en `.local-tools/missing-contacts-20261008/`; no contienen contactos reales.
