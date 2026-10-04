# Publicaciones identificables y migraciones verificadas

La rama parte del commit que registra exactamente los 937 archivos del despliegue
`592bc32f-7400-46dd-b904-660cfba7b85f`. La copia de trabajo anterior se conserva.
`releases/production-baseline.json` documenta las huellas de ese punto de partida.
Nunca publicar una carpeta de trabajo mediante `railway up` directamente.

## Preparación y publicación

1. Trabajar desde una rama que incluya el commit publicado. Confirmar los cambios
   en Git. El ejecutor rechaza cambios locales, archivos sin seguimiento y una
   versión que no descienda de la que está activa.
2. Usar Node 20 e instalar dependencias con `npm ci --ignore-scripts` en la raíz y
   `npm ci --prefix frontend`. No reutilizar dependencias de otra versión.
3. Configurar `OPS_TEST_DATABASE_URL` hacia PostgreSQL 17 local, como producción. Las pruebas crean y
   eliminan únicamente sus bases, esquemas o tablas temporales. Ejecutar:
   `node scripts/ops/release.mjs validate`.
   Se prueban migraciones reales, visibilidad e importaciones en PostgreSQL,
   conversaciones Cloud, la interfaz, tipos y compilación. La constancia
   queda vinculada al commit, árbol Git y catálogo exactos.
   Subir el mismo commit a GitHub y esperar que `Verified release checks / verify`
   termine correctamente. `npm run release:check-ci` comprueba el resultado.
   Autenticar `gh` (o indicar su ruta mediante `GH_CLI`). La rama `main` debe
   exigir el check `verify` de GitHub Actions (app 15368), también para admins,
   y prohibir force-push y eliminación.
4. Consultar el ID activo en Railway. Preparar una carpeta nueva:
   `node scripts/ops/release.mjs prepare --output /ruta/nueva --expect-active ID`.
   El contenido sale de `git archive`, sin datos, dependencias locales ni secretos.
5. Configurar las credenciales por entorno, nunca en Git: `DATABASE_URL`, la
   política TLS correspondiente y, si hace falta, `RAILWAY_CLI`. Ejecutar:
   `node scripts/ops/release.mjs deploy --artifact /ruta/nueva`.
   Se exige el último run de push exitoso del workflow para el SHA exacto, con su
   artefacto de validación vigente; un run pendiente, fallido, ausente o una falla
   de conexión bloquea el despliegue antes de las migraciones. Se vuelve a
   comprobar antes de subir. Los artefactos se retienen 90 días; repetir la
   validación en GitHub si expiraron, sin omitir controles.
   Se verifican archivos, ascendencia, versión activa, migraciones y estado de
   producción nuevamente antes de subir. Una publicación concurrente obliga a
   incorporar su commit y repetir las validaciones. Las migraciones deben ser
   compatibles con la versión previa mientras Railway cambia de contenedor.
6. Esperar `SUCCESS` en Railway y comprobar `/release.json`: debe identificar el
   commit preparado. Verificar los módulos afectados antes de dar por publicada
   la versión. Una subida aceptada no equivale a un despliegue terminado.

La reversión se hace con un nuevo commit que revierta el cambio sobre la rama
actual y pase las mismas comprobaciones. No bajar a una copia antigua ni borrar
el registro de migraciones. Los cambios de esquema requieren su migración
correctiva compatible; el sistema no ejecuta SQL de reversión automáticamente.

## Incorporación de la base existente

`db/migrations/baseline.json` contiene los hashes de los SQL históricos y la
huella de los objetos públicos de la base revisada. No afirma que cada archivo
histórico se ejecutó: registra el esquema existente como punto de partida.

- `node scripts/ops/run-migrations.mjs --catalog`: valida archivos sin conectar.
- `--fingerprint`: lee el esquema y devuelve hashes de objetos, sin filas de negocio.
- `--status` / `--dry-run`: consulta estado, sin crear tablas ni modificar datos.
- `--baseline --yes-i-know-this-is-production`: requiere coincidencia exacta del
  esquema revisado; crea únicamente el registro privado `app_migrations` y
  marca los SQL históricos como `baseline`. No los vuelve a ejecutar. Una base
  diferente exige revisión y un punto de partida propio; nunca copiar la huella
  a ciegas. La procedencia y el commit quedan guardados.
- `--check`: falla si falta la incorporación inicial, hay cambios en SQL ya
  registrados, archivos ausentes, migraciones pendientes/incompletas o cambios de esquema
  realizados fuera del ejecutor. Cada paso confirmado guarda su huella de esquema.

Las credenciales de migración deben poder crear el esquema privado; éste revoca
el acceso de PUBLIC. Ninguna ruta de la aplicación utiliza estas tablas. El antiguo endpoint
`POST /api/admin/migrate` devuelve 410 y no ejecuta SQL; las migraciones pasan
por este ejecutor.

## Migraciones nuevas

Agregar `db/migrations/142_descripcion.sql` (o el siguiente número libre, mayor
que 141). El descubrimiento y el registro son automáticos. No editar SQL ya
registrados: agregar una migración correctiva. Los archivos históricos quedan
sellados incluso cuando no estén disponibles en el antiguo `_migrations`.

Por defecto, cada archivo y su registro se confirman en una sola transacción.
No incluir `BEGIN`, `COMMIT` ni cambios de transacción: los controla el ejecutor.
`--apply` aplica pendientes bajo un lock de sesión de PostgreSQL; un segundo
proceso falla sin ejecutar SQL. El comando requiere confirmación explícita por
bandera para escribir en servidores remotos.

Para índices concurrentes u operaciones que PostgreSQL exige fuera de una
transacción, encabezar con `-- migrate: nontransactional`. Agregar el archivo
`142_descripcion.verify.sql` con un SELECT que devuelva exactamente una fila
`ok=true` cuando el resultado completo sea correcto (incluir `indisvalid` e
`indisready` para índices). Cada sentencia se ejecuta por separado y se registra.
Si se corta o falla, no se repite automáticamente una operación de resultado
incierto. Revisar y completar el trabajo; `--reconcile db/migrations/142_descripcion.sql`
comprueba la postcondición en una transacción de sólo lectura y registra su fin.

Para operaciones manuales, usar `-- migrate: manual` y la misma postcondición.
El despliegue queda detenido hasta realizar el procedimiento y ejecutar
`--record-manual db/migrations/142_descripcion.sql`. Ese comando verifica y
registra; nunca ejecuta el SQL manual. Los permisos/confirmaciones de cualquier
operación destructiva siguen correspondiendo a su alcance concreto.

## Límites operativos

La verificación usa el catálogo de objetos públicos, no valida la calidad de
cada fila histórica. Un baseline no sustituye una restauración probada de backup.
Ver [respaldos y restauración](database-backup-restore.md).
Los SQL manuales de reparación en `db/manual` son procedimientos operativos y
no se descubren como migraciones. Los archivos `.verify.sql` son postcondiciones,
no pasos independientes.
