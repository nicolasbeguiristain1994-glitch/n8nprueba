# Importar movimientos de casino desde Excel

El importador acepta las exportaciones mensuales `ganamos_AGENTE_YYYY-MM.xlsx`,
`argenbet_AGENTE_YYYY-MM.xlsx`, `zeus_AGENTE_YYYY-MM.xlsx` y
`bet30_AGENTE_YYYY-MM.xlsx`, con la hoja **Movimientos**. Recorre carpetas y
subcarpetas. Ignora archivos que no cumplen ese nombre, como listas de contactos.

```sh
node scripts/import-casino-excel.js --dry-run '/ruta/informes plataformas' '/ruta/Downloads'
# DATABASE_URL debe apuntar a la base elegida; nunca se imprime ni se copia al reporte.
node scripts/import-casino-excel.js --apply --migrate '/ruta/informes plataformas' '/ruta/Downloads'
```

Sin `--apply` no se conecta ni escribe en la base. `--migrate` instala la migración
126; la primera ejecución convierte `monto` a `numeric(20,2)` y puede bloquear
temporalmente consultas mientras PostgreSQL reescribe el histórico. Los importes
siguen expresados en **pesos**, sin multiplicar los datos existentes por 100.

Se valida todo antes de insertar. La carga usa una transacción, lock de importación,
verificación de cada movimiento y deduplicación por plataforma e ID original.
Las filas duplicadas con datos diferentes abortan. Argenbet conserva su UUID en
`source_id`; `id_rec` usa un identificador numérico negativo determinista por
compatibilidad con índices históricos. Una colisión se detecta y aborta.
Los IDs numéricos se preservan. Dos movimientos de igual monto y hora con IDs
distintos se conservan. Las horas se interpretan en Argentina (UTC−3).

Los registros históricos sin plataforma no se reclasifican automáticamente.
Un movimiento ya presente con el mismo ID y datos se reconoce como existente.
Las coincidencias ambiguas o contradictorias abortan la carga para revisión.

Cada movimiento nuevo conserva archivo y fila originales. `casino_excel_imports`
guarda SHA-256, período y cobertura de cada fuente. El reporte JSON (por defecto
`outputs/casino-excel-import/report.json`, configurable con `--report=...`) lista
fuentes, duplicados, exclusiones, sumas en centavos para control y resultados SQL.
Archivos sin detalle individual no generan transacciones. Detalle parcial no
equivale a historia completa: los segmentos se calculan sobre lo observado.

Después de confirmar la carga se ejecuta la segmentación de los contactos
alcanzados por la importación, consolidando también sus cuentas históricas.
Los contactos ajenos a la importación no se modifican. Puede omitirse con
`--skip-segmentation` para mantenimiento y ejecutarse después con
`node scripts/segmentar-casino-players.js --imported-only`. Sin ese flag se ejecuta
el recálculo general histórico. Si falla, los movimientos permanecen
cargados y el proceso termina con error explícito; el recálculo es repetible.

`casino_segmentation_players` combina los jugadores históricos y las cuentas
importadas, preservando identidades por plataforma sin romper los upserts
existentes de `casino_players`. `casino_contact_account_links` usa vínculos
explícitos por plataforma/panel; los nombres sin vínculo sólo se cruzan si son
inequívocos. Los segmentos, contadores, etiquetas y `contacts.platforms` alimentan
los filtros actuales de campañas. No se crean teléfonos ni se cambia consentimiento
de marketing, exclusiones o estado del contacto. No se envían campañas.

La lista de prioridades tiene un cálculo separado y mantiene su último run
completo. Después de importar, usar la acción de recalcular prioridades del panel
si se necesita refresco inmediato. El servicio actual requiere también la
migración existente `117_cps_ltv_columns.sql`.

Los filtros de Ganamos y Argenbet en la interfaz requieren publicar el código
del frontend. El importador y el recálculo pueden ejecutarse desde CLI.

Pruebas:
```sh
npm test -- --runInBand --runTestsByPath tests/casino-excel-import.test.js
# Base PostgreSQL exclusivamente local y desechable; la prueba usa un esquema aislado.
CASINO_TEST_DATABASE_URL=postgresql://localhost/test npm test -- --runInBand --runTestsByPath tests/casino-excel-integration.test.js
```
