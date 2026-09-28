# Traspaso a la Mac con el código de producción

## Objetivo y autorización

El usuario pidió auditar contactos, corregir la segmentación y pasar los arreglos a producción. Decidió completar la integración y publicación desde la otra Mac, donde está el código vigente. Esta rama transporta el cambio de contactos; **no es una base completa para reemplazar producción**. Conservar las mejoras de plantillas, filtros de movimientos y cualquier cambio posterior de esa Mac.

Repositorio: `nicolasbeguiristain1994-glitch/n8nprueba`.
Rama de transporte: `handoff/contactos-segmentacion-20260928`.
Base local antigua: `9466ceb37807db667e5653292a700511cde5c179`.
El commit de transporte agrega únicamente 20 archivos nuevos o modificados (código, pruebas, auditoría, esta guía y dos evidencias). No incluye el dashboard en curso, duplicados de archivos, credenciales ni dependencias instaladas.

## Integración sobre la versión vigente

1. Leer las instrucciones del repositorio de destino. Revisar `git status`, identificar la fuente exacta del último despliegue y preservar todos los cambios locales, incluidos los no confirmados. Crear una rama de integración sobre esa base; si hay trabajo sin commit, guardarlo de manera segura antes de integrar.
2. Hacer `git fetch origin handoff/contactos-segmentacion-20260928`. Registrar el SHA obtenido con `git rev-parse FETCH_HEAD` e inspeccionar `git show --stat FETCH_HEAD`.
3. Aplicar **solo ese commit**, por ejemplo mediante `git cherry-pick <SHA>`, sobre la rama de integración. No hacer merge de toda la rama antigua ni desplegarla directamente. Resolver los conflictos conservando las funcionalidades de producción. Si la arquitectura cambió, portar los arreglos equivalentes en lugar de reemplazar archivos enteros.
4. Revisar especialmente la página y endpoints de contactos: producción ya tenía filtros de días sin movimientos y movimientos dentro del período, ausentes en la base de transporte. Incorporar esos filtros a la función compartida y a listado, conteo, selección, descarga y exportación. Preservar cualquier semántica posterior de permisos, listas y plataformas.
5. Conservar los cambios nuevos del pipeline diario y del runner independiente. La lista operativa de agentes del módulo nuevo se debe conciliar con la fuente vigente. No volver a un pipeline anterior ni eliminar recálculos de prioridades ya publicados.

## Qué corrige

- Filtros y permisos compartidos entre listado, conteo, selección y exportación; límites explícitos en lugar de truncamiento silencioso.
- Selección consistente entre páginas, teléfonos conservados y protección frente a respuestas atrasadas.
- Motor compartido para importación y script: vínculos por cuenta/plataforma, múltiples cuentas consolidadas, fechas y etiquetas consistentes, transacciones atómicas.
- Promedios con importes y meses del mismo período, centavos conservados, historial parcial identificado y ausencia de fecha sin clasificar como perdido automáticamente.
- Ficha con todas las plataformas, sin mezclar homónimos.
- Pipeline detenido ante sincronizaciones incompletas.
- Estadísticas explícitas (`ANALYZE`) de tablas temporales para evitar planes muy lentos con el volumen real.

Detalles: `docs/audits/contactos-segmentacion-2026-09-28.md`.

## Validaciones realizadas y pendientes

En la Mac de origen aprobaron 38 pruebas: 15 del motor PostgreSQL, 17 de endpoints/filtros y 6 de importación Excel. Después de optimizar el rendimiento se repitieron y aprobaron las 15 del motor. Antes de subir esta rama se volvieron a ejecutar las 38 pruebas sobre el paquete aislado y todas aprobaron. También aprobaron sintaxis, `git diff --check` y una comprobación TypeScript aislada. **No se validó un build completo de la versión integrada**, porque esa fuente está en la Mac receptora. La comprobación global en origen tenía errores preexistentes en archivos duplicados `.next/types/* 2.ts` y en `frontend/lib/__tests__/cloud-api.test.ts`; resolver o evaluar estos sobre la fuente vigente, sin esconder errores nuevos.

Ejecutar tras integrar, con PostgreSQL temporal local y datos ficticios, nunca con la base de producción como URL de pruebas:

```sh
# Desde la raíz; sustituir el puerto por el de una instancia temporal aislada.
CONTACTS_TEST_DATABASE_URL=postgresql://localhost:55438/postgres node --test tests/contacts-segmentation.integration.cjs
CASINO_TEST_DATABASE_URL=postgresql://localhost:55438/postgres ./node_modules/.bin/jest tests/casino-excel-integration.test.js tests/casino-excel-import.test.js --runInBand
```

Desde `frontend`:

```sh
CONTACTS_TEST_DATABASE_URL=postgresql://localhost:55438/postgres ./node_modules/.bin/vitest run lib/__tests__/contacts-routes.integration.test.ts lib/__tests__/contacts-audience.test.ts lib/__tests__/casino-platform-filters.test.ts
npm run build
```

Agregar/verificar casos de los filtros de movimientos conservados en la integración. Probar staging usando una base aislada; comprobar que su configuración no apunte a producción antes de realizar escrituras de prueba.

## Infraestructura observada el 28/09/2026

Confirmar nuevamente estos datos: pueden existir publicaciones posteriores.

- Proyecto Railway `striking-love`, ID `b415f700-4a7f-44c5-9ae9-f8c97a2c0521`.
- Panel `whatsapp-panel`, ID `5ed7c2b8-9348-4269-b291-4043a0dce5b4`.
- Entornos `production` y `staging`.
- Producción observada: `fd550d54-fdfd-4dd6-8225-6b9380564306`, 28/09 17:10 UTC, publicación CLI de correcciones de plantillas sin commit asociado.
- Dominios `royalpulse.tech` y `whatsapp-panel-production-f768.up.railway.app`; staging `whatsapp-panel-staging.up.railway.app`.
- Panel: Dockerfile, `node server.js`, healthcheck `/login` en la configuración publicada.
- Servicio independiente `casino-daily-sync`, ID `56151abf-b88c-42bd-9a50-c9e63e077eb4`: publicación observada `d74451de-9717-41be-b374-ec01e5d646a7`, 24/09; runner personalizado `node daily.cjs`, cron `0 7 * * *`, restart NEVER. **No reemplazarlo con la imagen/configuración web**. Revisar su fuente exacta e integrar el nuevo motor en las rutas que utiliza realmente.
- El Dockerfile de este cambio copia el módulo a `/frontend/lib/casino-segmentation.js`, requerido por `/scripts/segmentar-casino-players.js`. Verificar también su inclusión en el contenedor del job independiente.

## Base real, simulación y aplicación

Se accedió a la base correcta mediante las variables del servicio Railway, sin guardar ni imprimir secretos. `.env.prod.local` en la Mac de origen tenía una credencial inválida y `.env` apuntaba a otra base de 78.286 contactos: **no usar esas alternativas**. La base real tenía **225.328** contactos no eliminados y las vistas `casino_segmentation_players` y `casino_contact_account_links` de la migración 126. No necesita reinstalarse esa migración a ciegas.

Últimos movimientos observados: Zeus y Bet30 27/09, Ganamos y Argenbet 23/09. Verificar actualización y cobertura por agente/plataforma antes de recalcular actividad; las cargas parciales no se vuelven completas con este cambio.

La primera simulación agotó 300 segundos. Se examinó el plan y agregaron estadísticas de tablas temporales. La repetición completa terminó en **31,9 segundos**, con rollback, sin modificar contactos ni jugadores:

- 24.876 contactos vinculados.
- 978 cambios de nivel **entre los vinculados**.
- 21.052 perfiles con estimación histórica.
- 27 historiales parciales.
- 0 actividades desconocidas entre esos perfiles.

Evidencias: `docs/audits/evidence/contactos-20260928/dry-run.txt` y `query-plan.txt`. La simulación no ejecuta `applySegmentation`: no valida escrituras, triggers ni el número de contactos sin vínculo que perderían métricas/etiquetas derivadas. **978 no es el impacto total**. Antes de aplicar, revisar también esos contactos y comparar actividad actual/propuesta. Validar los ejemplos de la auditoría inicial (Andrea03zz, Ale8676z y Agus796z) contra la última carga y la fecha actual.

Publicación y recálculo:

1. Preservar el identificador del despliegue anterior y un respaldo verificable, en ubicación segura, de los campos afectados en `contacts`, las etiquetas casino de `contact_tags` y las métricas afectadas de `casino_players`, con sus identificadores. No subir datos de contactos al repositorio.
2. Validar el cambio integrado en staging. Revisar si cambió producción durante la integración y conciliar cualquier publicación nueva.
3. Publicar panel y motor/job de forma coherente, conservando el runner diario real y evitando ejecuciones concurrentes de la versión vieja durante el recálculo. Mantener una vía de rollback de aplicación y datos; el rollback del contenedor por sí solo no restaura la segmentación.
4. Con la conexión correcta, correr `node scripts/segmentar-casino-players.js --dry-run` sobre la versión integrada. Revisar cobertura, diferencias y limpieza de no vinculados. Si el historial está incompleto o el impacto resulta inesperado, investigar antes de escribir.
5. Ejecutar `node scripts/segmentar-casino-players.js` cuando se cumplan esas verificaciones. Es una transacción y utiliza un advisory lock. `--skip-actividad` conserva actividad/antigüedad y recalcula riesgo con el nuevo nivel, pero no sustituye la validación de cobertura ni evita todas las demás escrituras.
6. Verificar salud del panel, filtros simples/combinados, paridad de listado/selección/CSV, permisos, etiquetas exclusivas, ejemplos auditados, fichas con varias cuentas y el siguiente ciclo del job diario. Informar URL, SHA integrado, despliegues, pruebas y resultado del recálculo.

No se ha publicado nada ni recalculado datos permanentes desde la Mac de origen. La autorización del usuario para completar integración y despliegue ya está dada; lo pendiente es ejecutar estas verificaciones sobre la fuente actual.
