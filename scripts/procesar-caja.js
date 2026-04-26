/**
 * Procesa los datos de Caja capturados (api_caja_capturada.json)
 * y genera la segmentación de jugadores por monto y actividad.
 *
 * Uso: node scripts/procesar-caja.js
 *
 * Output:
 *   exports/jugadores_metricas.json    → métricas por jugador
 *   exports/jugadores_segmentados.csv  → CSV listo para importar
 */

const fs   = require('fs');
const path = require('path');

const OUT_DIR    = path.join(__dirname, '../exports');
const INPUT_FILE = path.join(OUT_DIR, 'api_caja_capturada.json');

// ── Leer datos ───────────────────────────────────────────────────────────────
console.log('📂 Leyendo api_caja_capturada.json...');
const raw = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));

// Juntar todos los movimientos de todos los agentes
const todasLasTransacciones = [];
for (const [url, arr] of Object.entries(raw)) {
  if (!url.includes('movimiento-fichas')) continue;
  if (!Array.isArray(arr)) continue;
  // Extraer nombre de agente de la URL (?username=betcoin&...)
  const match = url.match(/username=([^&]+)/);
  const agente = match ? match[1] : 'desconocido';
  for (const item of arr) {
    todasLasTransacciones.push({ ...item, __agente__: agente });
  }
}

console.log(`✅ Total transacciones: ${todasLasTransacciones.length}`);

// ── Calcular métricas por jugador ────────────────────────────────────────────
const jugadoresMap = new Map();
const hoy = new Date();

for (const t of todasLasTransacciones) {
  const username = (t.username || '').trim();
  if (!username) continue;

  // Solo jugadores (no agentes)
  const roles = t.roles || '';
  if (!roles.includes('ROLE_APOSTADOR')) continue;

  const det = (t.detalles || '').toLowerCase();
  const esCarga = det.includes('carga');
  const esRetiro = det.includes('retiro');

  const monto = Math.abs(parseFloat(t.valor || 0));
  const fecha = new Date(t.fecha || 0);
  const agente = t.__agente__ || t.creator_username || '';

  if (!jugadoresMap.has(username)) {
    jugadoresMap.set(username, {
      username,
      agente,
      user_id: t.user || null,
      totalCargas:  0,
      cantCargas:   0,
      totalRetiros: 0,
      cantRetiros:  0,
      fechaPrimera: fecha,
      fechaUltima:  fecha,
      diasActivos:  new Set(),
    });
  }

  const j = jugadoresMap.get(username);
  if (fecha < j.fechaPrimera) j.fechaPrimera = fecha;
  if (fecha > j.fechaUltima)  j.fechaUltima  = fecha;
  j.diasActivos.add(fecha.toISOString().split('T')[0]);

  if (esCarga) {
    j.totalCargas += monto;
    j.cantCargas++;
  } else if (esRetiro) {
    j.totalRetiros += monto;
    j.cantRetiros++;
  }
}

console.log(`✅ Jugadores únicos: ${jugadoresMap.size}`);

// ── Construir array con frecuencias ─────────────────────────────────────────
const jugadores = [];
for (const [, j] of jugadoresMap) {
  if (j.cantCargas === 0) continue; // ignorar jugadores sin cargas

  const diasDesdeUltimo  = Math.floor((hoy - j.fechaUltima)  / 86400000);
  const diasDesdePrimero = Math.floor((hoy - j.fechaPrimera) / 86400000) || 1;
  const cantDias         = j.diasActivos.size;
  const freqSemanal      = +(cantDias / Math.max(diasDesdePrimero / 7, 1)).toFixed(2);

  jugadores.push({
    username:        j.username,
    agente:          j.agente,
    user_id:         j.user_id,
    totalCargas:     Math.round(j.totalCargas),
    cantCargas:      j.cantCargas,
    totalRetiros:    Math.round(j.totalRetiros),
    cantRetiros:     j.cantRetiros,
    diasDesdeUltimo,
    diasDesdePrimero,
    freqSemanal,
    fechaPrimera:    j.fechaPrimera.toISOString().split('T')[0],
    fechaUltima:     j.fechaUltima.toISOString().split('T')[0],
  });
}

// ── Percentiles para segmentación por monto ──────────────────────────────────
function percentil(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(Math.floor(p / 100 * s.length), s.length - 1);
  return s[idx] || 0;
}

const cargas = jugadores.map(j => j.totalCargas).filter(v => v > 0);
const p33 = percentil(cargas, 33);
const p66 = percentil(cargas, 66);
const p90 = percentil(cargas, 90);

function segMonto(v) {
  if (v >= p90) return 'vip';
  if (v >= p66) return 'alto';
  if (v >= p33) return 'medio';
  return 'bajo';
}

function segActividad(j) {
  if (j.diasDesdeUltimo > 60)   return 'inactivo';
  if (j.diasDesdeUltimo > 30)   return 'en_riesgo';
  if (j.diasDesdePrimero <= 30) return 'nuevo';
  if (j.freqSemanal >= 3)       return 'frecuente';
  if (j.freqSemanal >= 1)       return 'regular';
  return 'ocasional';
}

// ── Segmentar ────────────────────────────────────────────────────────────────
const segmentados = jugadores.map(j => ({
  ...j,
  seg_monto:     segMonto(j.totalCargas),
  seg_actividad: segActividad(j),
}));

// ── Distribución ─────────────────────────────────────────────────────────────
const distMonto = {}, distAct = {};
segmentados.forEach(j => {
  distMonto[j.seg_monto]     = (distMonto[j.seg_monto]     || 0) + 1;
  distAct[j.seg_actividad]   = (distAct[j.seg_actividad]   || 0) + 1;
});

// ── Guardar JSON ──────────────────────────────────────────────────────────────
const jsonPath = path.join(OUT_DIR, 'jugadores_metricas.json');
fs.writeFileSync(jsonPath, JSON.stringify(segmentados, null, 2));
console.log(`💾 JSON: ${jsonPath}`);

// ── Guardar CSV ───────────────────────────────────────────────────────────────
const headers = [
  'username', 'agente', 'user_id',
  'totalCargas', 'cantCargas', 'totalRetiros', 'cantRetiros',
  'freqSemanal', 'diasDesdeUltimo', 'fechaPrimera', 'fechaUltima',
  'seg_monto', 'seg_actividad',
];
const csv = [
  headers.join(','),
  ...segmentados.map(j =>
    headers.map(h => `"${String(j[h] ?? '').replace(/"/g, '""')}"`).join(',')
  ),
].join('\n');

const csvPath = path.join(OUT_DIR, 'jugadores_segmentados.csv');
fs.writeFileSync(csvPath, csv, 'utf8');
console.log(`💾 CSV: ${csvPath}`);

// ── Resumen ───────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════');
console.log(`✅ Jugadores segmentados: ${segmentados.length}`);
console.log('\nRANGOS DE MONTO (período capturado):');
console.log(`  Bajo   → $0 – $${Math.round(p33).toLocaleString('es-AR')}`);
console.log(`  Medio  → $${Math.round(p33).toLocaleString('es-AR')} – $${Math.round(p66).toLocaleString('es-AR')}`);
console.log(`  Alto   → $${Math.round(p66).toLocaleString('es-AR')} – $${Math.round(p90).toLocaleString('es-AR')}`);
console.log(`  VIP    → +$${Math.round(p90).toLocaleString('es-AR')}`);
console.log('\nDISTRIBUCIÓN POR MONTO:');
['vip','alto','medio','bajo'].forEach(k =>
  console.log(`  ${k.padEnd(6)}: ${(distMonto[k]||0).toString().padStart(6)} jugadores`)
);
console.log('\nDISTRIBUCIÓN POR ACTIVIDAD:');
['frecuente','regular','nuevo','ocasional','en_riesgo','inactivo'].forEach(k =>
  console.log(`  ${k.padEnd(10)}: ${(distAct[k]||0).toString().padStart(6)} jugadores`)
);
console.log('══════════════════════════════════════════');
