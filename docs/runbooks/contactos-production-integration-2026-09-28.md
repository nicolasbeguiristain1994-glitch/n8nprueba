# Integración de contactos sobre producción — 28/09/2026

Origen autorizado: `110f86d01db15880c76af8d8777599ef40a60079`, rama de transporte `handoff/contactos-segmentacion-20260928`.

## Fuente y preservación

Se verificó en Railway que el panel vigente era `fd550d54-fdfd-4dd6-8225-6b9380564306`. Sus 841 archivos coinciden con el manifiesto de la corrección de plantillas. Se creó una rama aislada sobre ese snapshot y se aplicó sólo el commit de transporte, resolviendo diferencias. El checkout de trabajo y sus cambios sin confirmar se preservaron; hay un respaldo privado de los archivos locales.

El worker vigente era `d74451de-9717-41be-b374-ec01e5d646a7`; sus 19 archivos coinciden con `.local-tools/priorities-audit/worker-manifest.json`. Su fuente se incorpora bajo `services/casino-exact-daily` para registrar ambos artefactos. Se conserva el runner `daily.cjs`, cron `0 7 * * *`, restart NEVER, cursores, reglas financieras y recálculo de prioridades.

## Resolución de diferencias

- Listado, conteo, selección, descarga y CSV comparten filtros. Se conserva la consulta materializada de movimientos vigente y sus modos de último movimiento y movimientos dentro del período, con límites y zona horaria de Argentina.
- La página conserva esos controles e incorpora selección entre páginas, teléfonos y rechazo de respuestas atrasadas.
- Los scripts legacy de sincronización y pipeline se conservan: ya detienen segmentación/prioridades ante fallo, parcial u omisión. No se restaura el runner antiguo del traspaso.
- El job real ejecuta el motor compartido después de completar todos los agentes y antes de prioridades. Registra estado de segmentación y revierte su transacción ante error.
- `CASINO_SEGMENTATION_PRESERVE_ACTIVITY_PLATFORMS=ganamos,argenbet` conserva actividad y antigüedad de contactos vinculados a esas plataformas, incluyendo personas con varias cuentas. El nivel, métricas y riesgo se recalculan. La preservación debe retirarse sólo después de comprobar cobertura actual por agente. Las cargas observadas llegan al 22/23 de septiembre; Zeus y Bet30 sí tienen cursores completos hasta el 27.
- El módulo `.js` del worker es una copia idéntica del motor del panel; verificar su hash en cada publicación conjunta.

## Validación

- PostgreSQL temporal exclusivo `127.0.0.1:55438`, datos ficticios: 16 pruebas del motor, 6 de Excel, 22 de endpoints/filtros y 12 del runner diario, sin omisiones en su ejecución final.
- Suite combinada frontend: 67 pruebas aprobadas, incluyendo regresiones de movimientos y validación de plantillas.
- Build con Node 20 y Next.js 16.2.3; TypeScript sin errores.
- Staging `d8138db6-6a78-4760-8da6-dc4132dbb554` SUCCESS. Se descubrió que apuntaba a producción y se separó antes de las pruebas: base exclusiva `contacts_stage_20260928` en el PostgreSQL Railway de staging, credenciales de sesión independientes, scheduler y sync deshabilitados.
- Smoke HTTP autenticado aprobado: importación transaccional, etiquetas exclusivas, ficha con dos plataformas, filtros y paridad de audiencias, rechazo sin sesión y rechazo de exportación al operador sin permiso.

## Impacto previo

Simulación con rollback: 24.876 vinculados, 978 cambios de nivel entre ellos, 21.052 estimaciones históricas y 27 historiales parciales. Hay además 559 contactos sin vínculo respaldado: 457 tenían nivel derivado y 520 tenían fecha. Se investigó el desacuerdo entre panel explícito y agente fuente, además de las ambigüedades; no se fuerza asociación por nombre. La limpieza elimina métricas/etiquetas exclusivas sin sustento, no contactos ni etiquetas personalizadas.

La evidencia privada y los respaldos de campos afectados están fuera del repositorio, en `.local-tools/contacts-integration-20260928/`. Se incluyen `casino_accounts`, `platforms` y timestamps además de niveles, métricas, etiquetas con IDs y campos de `casino_players`. Los archivos comprimidos se vuelven a leer y verificar con conteos y SHA-256.

La publicación y el recálculo se registrarán en el acta final del checkout de trabajo. Revertir sólo la imagen no revierte los datos. Los identificadores anteriores de panel y worker indicados arriba permiten restaurar aplicación; la restauración de datos debe usar el respaldo previo y comprobar que no sobrescribe modificaciones posteriores.

## Ajuste posterior al recálculo: movimientos y CSV

La verificación productiva detectó `Query read timeout` con el volumen real. Al enriquecer las cuentas, la vista de vínculos cambió de cardinalidad y el plan de un filtro estrecho pasó a repetir lecturas; empujar directamente ese filtro dentro de la vista también superó 60 segundos en una prueba con rollback.

La resolución compartida ahora materializa primero los vínculos, agrega índices y `ANALYZE`, aplica permisos y filtros a esa tabla temporal, y agrega movimientos por cuenta antes de unirlos. Usa una conexión dedicada con timeout local de 60 segundos; no cambia el timeout global de la aplicación ni crea objetos permanentes. La medición real de la variante agregada terminó en 14,2 segundos para una búsqueda estrecha y 13,3 para toda Zeus (1.108 coincidencias en ese momento). La variante de join directo sólo era rápida para audiencias pequeñas y se descartó.

Se preserva además la columna CSV de días desde el último movimiento, o desde el último movimiento dentro del período según el modo; incluye retiros. Sin rango no inventa una antigüedad desde otro campo. Las 22 pruebas de contactos incluyen verificación exacta de esos valores y de la paridad de audiencias. Build completo y TypeScript aprobados. Este ajuste no cambia el motor de segmentación ni requiere otro recálculo de datos.
