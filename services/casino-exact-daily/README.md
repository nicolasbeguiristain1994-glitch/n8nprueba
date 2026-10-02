# Runner diario de producción

Cron Railway: `0 7 * * *` (04:00 Argentina), comando `node daily.cjs`, restart NEVER.

Conserva ingesta exacta Zeus/Bet30, repetición sin duplicados, locks y cursores. Después de un ciclo apply sin agentes fallidos ejecuta `segmentation.cjs` con el motor `casino-segmentation.js`, y sólo tras confirmar esa transacción solicita el recálculo de prioridades. Preview o sync incompleto no segmentan ni recalculan prioridades. Un error de segmentación revierte ese paso, registra fallo y termina con error; los cursores de ingesta ya confirmados se conservan y permiten repetir el siguiente ciclo.

`CASINO_EXACT_DAILY_ENABLED=0` pausa el worker. Mantener `CASINO_SYNC_PAUSED=true` para el pipeline legacy. No sustituir este Dockerfile/comando por los del panel.

`CASINO_SEGMENTATION_PRESERVE_ACTIVITY_PLATFORMS=ganamos,argenbet` protege actividad y antigüedad mientras esas plataformas no tengan cobertura vigente. Retirarlo exige verificar la cobertura, no sólo el máximo de fecha global.

El motor es una copia idéntica de `frontend/lib/casino-segmentation.js` del panel. Sincronizar ambos archivos y comparar SHA-256 al preparar el artefacto. Las pruebas PostgreSQL requieren `CASINO_TEST_DATABASE_URL` local en puerto 55432 o 55438; crean y eliminan una base ficticia.
