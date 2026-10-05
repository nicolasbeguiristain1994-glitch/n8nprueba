# Segmentación de contactos — mejora del 5 de octubre de 2026

## Comportamiento

- Un único umbral monetario configurable en Ajustes clasifica los depósitos por mes activo en Contactos y Dashboard. El dashboard describe cuentas; Contactos consolida cuentas vinculadas de una persona. Los meses compartidos se cuentan una sola vez.
- Se usa el importe original, la fecha Argentina y la exclusión de bonos identificados del ledger financiero. Los depósitos históricos sin movimientos detallados se muestran como estimados; las cuentas con movimientos y conteos históricos mayores, como parciales. Esto no certifica cobertura externa completa.
- La ficha explica promedio, meses, primera/última carga conocida, importes y cantidades de 30/90 días, fecha del cálculo y sincronización por plataforma. Los períodos recientes se anclan al último cálculo. La actividad y antigüedad se calculan con la fecha actual al consultar, aunque no haya nueva importación.
- «Sin historial vinculado» y «Sin depósitos registrados» son estados explícitos; no equivalen a inactivo. «12 meses sin depósitos registrados» exige una fecha conocida anterior al corte.
- Una edición manual del nivel se conserva hasta elegir «Usar nivel calculado». Editar nombre/agente sin cambiar el nivel no crea una excepción manual. Las elecciones se registran en la auditoría existente.
- Guardar lista desde los filtros permite crear una audiencia dinámica. Cada campaña nueva resuelve los filtros con los permisos de su responsable; se congela incluso una audiencia vacía. Los reintentos conservan la misma selección. Las listas existentes siguen siendo fijas. El conteo visible de una dinámica es la última selección resuelta, no una consulta continua.
- Consentimiento, blacklist, estado activo y frecuencia siguen verificándose al enviar. Esta entrega no altera consentimientos ni ejecuta campañas.

## Migración y publicación

Migración aditiva `143_contact_segmentation_profiles.sql`, con verificación independiente, RLS y vistas security_invoker. La aplicación usa autenticación propia; los roles de cliente Supabase no reciben acceso a las nuevas audiencias o movimientos. Los umbrales iniciales se alinean con los seis niveles anteriores de Contactos. El trigger rechaza umbrales desordenados; la API mantiene control de concurrencia.

Antes de publicar: respaldo, validación del commit exacto y GitHub, migración mediante `scripts/ops/run-migrations.mjs`, ensayo/recálculo con lock `casino-segmentation`, publicación mediante `scripts/ops/release.mjs`, comprobación de API y actualización de la copia del motor usada por importaciones diarias. El panel no debe publicarse con los perfiles sin inicializar.

El servicio Railway diario activo al iniciar este trabajo era `9ea7d5c0-b6c0-4d6f-8560-5e79fcd7cf14`. Su paquete de 30 archivos coincide con el manifiesto privado de la publicación del 01/10; tiene extensiones que no están en el snapshot Git del panel. Para actualizarlo se conserva ese paquete verificado y se reemplaza únicamente `contact-segmentation.cjs` por el motor compartido de este commit. Se conservan cron, variables y selección Zeus/Bet30. El colector local de Ganamos/Argenbet usa la misma copia y también requiere actualizarla. No usar la carpeta histórica del worker incluida en el snapshot del panel para reemplazar el servicio completo.

## Verificación

Las pruebas PostgreSQL comprueban límites monetarios, meses compartidos, vínculos ambiguos, bonos, precisión original, historial parcial/estimado, niveles manuales, cambio de actividad con el calendario, permisos y audiencias congeladas. El comando de validación del release ahora incluye la integración del motor además del frontend, migraciones, tipos y build.

Ensayo en una copia aislada del respaldo del 04/10: 225.328 contactos, 24.890 perfiles vinculados, 23 cambios de nivel, 20.895 perfiles con alguna cuenta estimada, 8 con historial parcial y 5 sin actividad conocida. Preparación 6,7 s; recálculo y commit 15,5 s. No equivale a conteo actual de producción. Los valores exactos de la publicación se verifican nuevamente sobre producción.

Quedan fuera de esta entrega: certificación de consentimiento histórico, perfiles monetarios independientes por plataforma y atribución causal de resultados comerciales. El origen del dato y su antigüedad permanecen visibles para evitar interpretaciones incorrectas.
