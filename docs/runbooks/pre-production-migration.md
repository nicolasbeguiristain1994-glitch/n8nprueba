# Comprobación previa a migrar producción

1. Identificar el commit activo en `/release.json` y partir de una rama que lo
   incluya. Mantener la copia de trabajo limpia y pasar la validación local y de
   GitHub para el commit exacto. Ver [publicaciones verificadas](verified-releases.md).
2. Confirmar un respaldo reciente y recuperable. Seguir el procedimiento de
   [respaldo y prueba de restauración](database-backup-restore.md). El baseline de
   migraciones y el respaldo de código en GitHub no son copias de los datos.
3. Ejecutar `node scripts/ops/run-migrations.mjs --catalog` y luego `--status`
   con las credenciales adecuadas en el entorno. `--dry-run` solo consulta el
   estado; no simula ni aplica los SQL.
4. Probar los SQL pendientes en una base de ensayo compatible y revisar sus
   precondiciones. Las migraciones deben funcionar mientras la versión anterior
   de la aplicación sigue activa. No editar ni repetir migraciones históricas.
5. Aplicar cambios ordinarios mediante `scripts/ops/release.mjs deploy`.
   El ejecutor comprueba y aplica migraciones antes de subir la versión.
   Las operaciones especiales se declaran `nontransactional` o `manual`, con
   postcondición y reconciliación según el runbook de publicaciones.
6. Verificar `--check`, despliegue `SUCCESS`, identidad publicada y funciones
   afectadas. La evidencia se registra en `app_migrations`, no en `_migrations`.

No ejecutar SQL pegado en un endpoint ni publicar con `railway up` directamente.
Para volver atrás en código, crear un commit correctivo y validarlo. Restaurar
sobre producción reemplaza datos posteriores: requiere un plan específico.
Este procedimiento no autoriza borrar tablas ni datos históricos.
