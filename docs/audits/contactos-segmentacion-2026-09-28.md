# Correcciones de contactos y segmentación — 28/09/2026

Implementadas en el repositorio. No desplegadas ni ejecutadas sobre la base de producción.

## Comportamiento corregido

- Listado, conteo, selección y CSV comparten filtros, incluidos lista, etiqueta, permisos, plataforma y contactos eliminados. Los filtros múltiples aceptan CSV y parámetros repetidos.
- Seleccionar o exportar más de 100.000 contactos devuelve un error explícito; nunca una audiencia incompleta silenciosa. La descarga paginada de contactos conserva su mecanismo por lotes.
- La pantalla envía los mismos filtros en todas las acciones, reinicia la selección al cambiar de audiencia y evita que respuestas atrasadas sustituyan los resultados actuales. Conserva los teléfonos de selecciones entre páginas.
- Importación y CLI usan `frontend/lib/casino-segmentation.js`. Cambios de nivel, contadores y familias de etiquetas se aplican en una transacción. Si falla el cálculo, la importación revierte sus escrituras.
- Los vínculos de cuentas explícitos y el nombre único se resuelven mediante las vistas de la migración 126. La ficha agrupa todas las cuentas por plataforma y no mezcla homónimos.
- Importe y meses proceden del mismo conjunto de cargas disponibles. Nunca se divide el importe histórico completo por los meses de una importación parcial. Cuando no hay transacciones, el nivel se estima sobre los meses calendario del período histórico conocido. Si falta ese período, no se inventa un nivel.
- El promedio conserva centavos hasta clasificar. $1.500.000 corresponde a Vip Alto. El contacto suma sus cuentas y cuenta una sola vez los meses compartidos.
- La actividad y `last_deposit_at` utilizan la última carga conocida entre historial y transacciones vinculadas. Fecha desconocida no equivale a perdido. Las frecuencias se calculan sobre el perfil consolidado.
- Se eliminan etiquetas derivadas obsoletas y métricas sin respaldo al perder el vínculo. Las etiquetas personalizadas se conservan.
- `--skip-actividad` conserva la actividad y antigüedad, pero ajusta el riesgo al nivel nuevo usando la actividad preservada.
- El runner de sincronización devuelve error si falló algún agente. El pipeline intenta ambas plataformas, pero no ejecuta segmentación/prioridades si hubo un fallo de sincronización; también se detiene si falla la segmentación.
- Las ayudas de actividad reflejan 31–60 días, 61–180 días y más de 180 días; nuevo corresponde a hasta 30 días desde la primera carga.

Los historiales parciales siguen siendo parciales: el cambio evita mezclar períodos, no reconstruye movimientos inexistentes. La vista histórica `casino_players` conserva su identidad global por username; no se rediseñó su almacenamiento en esta corrección. Los vínculos ambiguos quedan sin clasificar hasta disponer de una identidad explícita.

## Comprobación local

Resultado final: **38 pruebas aprobadas** (15 del motor con PostgreSQL, 17 de endpoints/filtros y 6 de importación Excel). También aprobaron la comprobación aislada de TypeScript, la sintaxis de los scripts y `git diff --check`. La instancia temporal se detuvo al terminar.

Pruebas con PostgreSQL temporal aislado en localhost y datos ficticios, sin cargar credenciales de producción:

```sh
CONTACTS_TEST_DATABASE_URL=postgresql://localhost:55438/postgres node --test tests/contacts-segmentation.integration.cjs
cd frontend
CONTACTS_TEST_DATABASE_URL=postgresql://localhost:55438/postgres ./node_modules/.bin/vitest run lib/__tests__/contacts-routes.integration.test.ts lib/__tests__/contacts-audience.test.ts lib/__tests__/casino-platform-filters.test.ts
```

También se ejecutaron las pruebas existentes de importación Excel (`casino-excel-import.test.js` y `casino-excel-integration.test.js`) sobre la misma instancia local.

La comprobación global de TypeScript encuentra errores preexistentes en `.next/types/* 2.ts` y `frontend/lib/__tests__/cloud-api.test.ts`. La comprobación aislada que excluye esos archivos valida el código de aplicación y las pruebas nuevas. No se cambiaron esos archivos ajenos a esta corrección.

## Aplicación en producción

1. Conciliar primero la versión desplegada: el panel observado tiene dos filtros de movimientos ausentes del checkout local. Integrar este cambio sobre esa versión para no perderlos.
2. Confirmar la base correcta y la migración 126 (`casino_segmentation_players`, `casino_contact_account_links`). La credencial de `.env.prod.local` falló en la auditoría y `.env` apuntó a otra base. No usar la alternativa para aplicar este cambio.
3. Desplegar aplicación, scripts y módulo compartido juntos. El Dockerfile incluye el módulo en la ruta que utiliza el CLI.
4. Confirmar cobertura de movimientos por plataforma/agente y ejecutar `node scripts/segmentar-casino-players.js --dry-run` con la conexión correcta. El resumen informa contactos vinculados, niveles que cambiarían, estimaciones históricas, historiales parciales y actividad desconocida. La corrida sólo crea tablas temporales y revierte la transacción.
5. Revisar el resumen y ejecutar el script sin `--dry-run` sobre la misma versión y base. La operación es transaccional; no aplicar si la sincronización está incompleta.
6. Verificar los siete contactos de la auditoría inicial, los filtros de actividad y la paridad de listado/selección/exportación. El nivel de un contacto no se valida con el importe de un único mes aislado.

Al cerrar la corrección inicial aún no se habían creado commits. El traspaso posterior se documenta en `docs/handoffs/contactos-segmentacion-2026-09-28.md`; excluye los cambios preexistentes del dashboard.

## Preflight autorizado de producción

Se confirmó acceso a Railway y a la base real (225.328 contactos), sin guardar credenciales. La publicación vigente es `fd550d54-fdfd-4dd6-8225-6b9380564306` del 28/09 17:10 UTC, subida por CLI sin commit asociado; incluye cambios de plantillas y filtros de movimientos ausentes en el checkout. Se solicitó la ubicación de esa fuente para conciliar antes de publicar.

La primera simulación agotó 300 segundos al cruzar movimientos. El plan mostraba un recorrido por índice y merge join sobre 2,7 millones de movimientos, por falta de estadísticas de tablas temporales. Se agregaron `ANALYZE` de esas tablas; el plan cambió a hash join. La simulación completa posterior terminó correctamente en **31,9 segundos**, revirtiendo su transacción: **24.876** contactos vinculados, **978** cambios de nivel entre esos contactos, **21.052** estimaciones históricas y **27** historiales parciales. Esto no cuenta la limpieza de perfiles sin vínculo y no equivale a validar que el historial esté completo. Las 15 pruebas PostgreSQL del motor se repitieron y aprobaron. No se publicaron cambios ni se recalcularon datos permanentes.

Evidencia y paquete acotado: `outputs/contacts-production-20260928/`.
