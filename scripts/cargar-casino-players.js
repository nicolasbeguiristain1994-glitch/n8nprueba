/**
 * OBSOLETO desde la migración 127 (fase 1, identidad multi-plataforma).
 *
 * Este script hacía upsert masivo de exports/jugadores_metricas.json en
 * casino_players vía `ON CONFLICT (username_lower)`. La migración 127
 * reemplaza ese índice único global por uno compuesto
 * `(platform, username_lower)` (el mismo username puede ser un jugador
 * distinto en cada plataforma). jugadores_metricas.json es un export legacy
 * de un único negocio y no trae `platform`, así que este script no puede
 * participar en la nueva identidad sin inventar una plataforma.
 *
 * Reemplazo: scripts/rebuild-casino-players-from-db.js (recompone
 * casino_players platform-aware desde casino_transactions) o
 * scripts/segmentar-casino-players.js.
 */

console.error('❌ Script obsoleto: casino_players ahora tiene identidad (platform, username_lower)');
console.error('   (migración 127) y jugadores_metricas.json no incluye platform.');
console.error('   Usar scripts/rebuild-casino-players-from-db.js o scripts/segmentar-casino-players.js.');
process.exit(1);
