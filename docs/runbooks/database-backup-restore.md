# Respaldos y prueba de recuperación

El respaldo de código en GitHub no incluye la base de datos. Los archivos de este
procedimiento contienen información privada y deben permanecer fuera de Git,
artefactos de Actions y directorios públicos. Permisos: carpetas `0700`, archivos
`0600`. El script no cifra el archivo: para copiarlo fuera del equipo, usar un
destino privado y cifrado aprobado por el propietario.

## Cobertura

`database-backup.mjs` guarda todos los datos y definiciones de `public` y
`app_migrations`: contactos, conversaciones, campañas, usuarios de la aplicación,
transacciones y el registro de migraciones. Usa `pg_dump` en formato custom y una
transacción de solo lectura con snapshot exportado. Los conteos y sumas de
contenido se calculan sobre ese mismo snapshot, aunque producción siga cambiando.
La integridad del archivo se comprueba además con SHA-256.

Esta copia es de la aplicación; no reemplaza el respaldo integral de Supabase.
Excluye esquemas administrados (`auth`, `storage`, `realtime`, `vault`), archivos
de Storage y configuración/credenciales del proveedor. No conserva propietarios
ni ACL globales. Las políticas RLS de la aplicación sí se conservan; los roles
necesarios se crean como NOLOGIN solo en el servidor local de prueba. Revisar
dependencias nuevas hacia esquemas administrados antes de ampliar la aplicación.

## Crear una copia

Requisitos: Node.js 20, dependencias del proyecto y herramientas PostgreSQL de la
misma versión mayor que producción (actualmente 17). `PG_BIN` puede indicar el
directorio de `pg_dump` y `pg_restore`.

1. Obtener la conexión desde el gestor de secretos. Cargarla en
   `BACKUP_DATABASE_URL`, nunca escribirla en el comando, logs o repositorio.
   Usar conexión directa o pooler de sesión, sin parámetros de URL.
2. Mantener TLS con verificación de certificado; `PGSSLROOTCERT` permite indicar
   el certificado CA del proveedor. `DB_SSL_REJECT_UNAUTHORIZED=false` conserva
   TLS pero desactiva la verificación de CA: solo usarlo si la configuración de
   conexión existente lo exige, y documentar esa limitación.
3. Ejecutar en una carpeta nueva dentro de una ubicación privada:

```sh
npm run backup:create -- .local-tools/database-backups/FECHA-UTC
```

La carpeta debe no existir. Solo una ejecución exitosa crea `manifest.json`.
Una carpeta sin manifiesto representa un intento incompleto. No reemplazar una
copia buena por un intento incompleto; revisar su log privado.

## Restaurar y verificar sin tocar producción

Preparar un PostgreSQL local independiente con la misma versión mayor y
extensiones de producción. Configurar `RESTORE_TEST_DATABASE_URL` con un usuario
local que pueda crear una base de datos; los servidores remotos y los parámetros
que permiten cambiar el host están prohibidos.

```sh
npm run backup:verify-restore -- .local-tools/database-backups/FECHA-UTC
```

El comando verifica el SHA-256 antes de restaurar, crea una base nueva con nombre
`restore_probe_*`, restaura con parada ante el primer error y compara TODAS las
tablas, conteos y sumas de contenido. Revisa índices inválidos y produce un
`restore-proof-*.json` solo si todo coincide. No arranca la aplicación, workers ni
envíos de WhatsApp. Nunca ejecuta DROP DATABASE: la copia local queda disponible
para inspección y su limpieza debe hacerse explícitamente.

La prueba mide la recuperación de datos y esquema; no acredita los servicios de
Supabase excluidos ni sustituye una prueba funcional completa del sistema.

## Política operativa y evidencia del proveedor

Objetivo propuesto: copias diarias, al menos siete días de retención y una copia
previa a cambios de datos irreversibles; prueba de recuperación mensual y tras
cambios de esquema relevantes. Confirmar el RPO/RTO que el negocio necesita antes
de contratar PITR u otros servicios. Este runbook no activa una programación.

En Supabase → Database → Backups, registrar sin credenciales: plan, retención,
última copia exitosa y estado de PITR. La lectura SQL de la base no permite
confirmar esa configuración. Si falta una copia reciente o falla la recuperación,
resolverlo antes de cambios destructivos. Restaurar sobre producción requiere un
plan específico porque reemplaza datos posteriores al respaldo.

Referencias: [Supabase backups](https://supabase.com/docs/guides/platform/backups),
[PostgreSQL pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html).
