/**
 * Analiza el historial de jugadores y propone rangos de segmentación
 *
 * Uso:
 *   1. Copiá el Excel en: exports/historial.xlsx
 *   2. node scripts/analizar-historial.js
 *
 * Output:
 *   exports/analisis_jugadores.json   → métricas por jugador
 *   exports/segmentos_propuestos.json → rangos recomendados
 *   exports/jugadores_segmentados.csv → jugadores con su segmento asignado
 */

const XLSX = require('xlsx');
const fs   = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '../exports');

const ARCHIVOS_AGENTES = [
  { agente: 'betcoin',  archivo: 'betcoin.xlsx'  },
  { agente: 'bigwin',   archivo: 'bigwin.xlsx'   },
  { agente: 'farabet',  archivo: 'farabet.xlsx'  },
  { agente: 'ofizeus',  archivo: 'ofizeus.xlsx'  },
  { agente: 'royal',    archivo: 'royal.xlsx'    },
];

// También acepta nombres con espacios como "Ultimos 6 meses betcoin.xlsx"
function buscarArchivo(nombreBase) {
  const archivosEnDir = fs.readdirSync(OUT_DIR);
  const exacto = archivosEnDir.find(f => f.toLowerCase() === nombreBase.toLowerCase());
  if (exacto) return path.join(OUT_DIR, exacto);
  const parcial = archivosEnDir.find(f => f.toLowerCase().includes(nombreBase.toLowerCase().replace('.xlsx','')));
  if (parcial) return path.join(OUT_DIR, parcial);
  return null;
}

// ── 1. Leer y parsear todos los Excel ────────────────────────────────────────
console.log('📂 Leyendo archivos de historial...');
const rows = [];
for (const { agente, archivo } of ARCHIVOS_AGENTES) {
  const filePath = buscarArchivo(archivo);
  if (!filePath) {
    console.log(`  ⚠️  No encontrado: ${archivo} (buscando en exports/)`);
    continue;
  }
  const wb    = XLSX.readFile(filePath);
  const ws    = wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(ws, { defval: '' });
  for (const f of filas) {
    f.__agente__ = agente;
    rows.push(f);
  }
  console.log(`  ✅ ${agente}: ${filas.length} filas`);
}

if (rows.length === 0) {
  console.error('❌ No se encontró ningún archivo. Copiá los xlsx en exports/ y volvé a correr.');
  process.exit(1);
}
console.log(`\n   Total: ${rows.length} filas`);

// Detectar nombres de columnas (pueden variar según el idioma/export)
const sample = rows[0] || {};
console.log('   Columnas detectadas:', Object.keys(sample).join(', '));

// Normalizar nombres de columnas
function detectCol(obj, candidatos) {
  for (const c of candidatos) {
    const key = Object.keys(obj).find(k => k.toLowerCase().includes(c.toLowerCase()));
    if (key) return key;
  }
  return null;
}

const COL_FECHA    = detectCol(sample, ['fecha', 'date', 'time']);
const COL_JUGADOR  = detectCol(sample, ['jugador', 'player', 'user', 'id jugador']);
const COL_OPERACION= detectCol(sample, ['operacion', 'operación', 'tipo', 'type']);
const COL_MONTO    = detectCol(sample, ['monto', 'amount', 'importe', 'apuesta']);
const COL_JUEGO    = detectCol(sample, ['juego', 'game', 'marca', 'marca']);

console.log(`   Columnas mapeadas:`);
console.log(`     Fecha: ${COL_FECHA} | Jugador: ${COL_JUGADOR} | Operación: ${COL_OPERACION} | Monto: ${COL_MONTO}`);

// ── 2. Filtrar últimos 6 meses ───────────────────────────────────────────────
const hoy        = new Date();
const hace6meses = new Date(hoy);
hace6meses.setMonth(hoy.getMonth() - 6);

function parseDate(val) {
  if (!val) return null;
  if (val instanceof Date) return val;
  // Excel serial number
  if (typeof val === 'number') return XLSX.SSF.parse_date_code(val);
  const d = new Date(val);
  return isNaN(d) ? null : d;
}

const rowsFiltradas = rows.filter(row => {
  const fecha = parseDate(row[COL_FECHA]);
  if (!fecha) return false;
  const d = fecha instanceof Date ? fecha : new Date(fecha.y, fecha.m - 1, fecha.d);
  return d >= hace6meses;
});

console.log(`\n📅 Últimos 6 meses: ${rowsFiltradas.length} transacciones`);

// ── 3. Calcular métricas por jugador ─────────────────────────────────────────
console.log('\n📊 Calculando métricas por jugador...');

const jugadoresMap = new Map();

for (const row of rowsFiltradas) {
  const jugadorId = String(row[COL_JUGADOR] || '').trim();
  if (!jugadorId) continue;

  const monto     = parseFloat(String(row[COL_MONTO] || '0').replace(',', '.')) || 0;
  const operacion = String(row[COL_OPERACION] || '').toLowerCase();
  const fechaRaw  = parseDate(row[COL_FECHA]);
  const fecha     = fechaRaw instanceof Date ? fechaRaw : new Date(fechaRaw?.y, fechaRaw?.m - 1, fechaRaw?.d);

  const agente = row.__agente__ || 'desconocido';

  if (!jugadoresMap.has(jugadorId)) {
    jugadoresMap.set(jugadorId, {
      id:              jugadorId,
      agente,
      totalDepositos:  0,
      totalRetiros:    0,
      totalApuestado:  0,
      cantTransacc:    0,
      diasActivo:      new Set(),
      fechaPrimera:    fecha,
      fechaUltima:     fecha,
    });
  }

  const j = jugadoresMap.get(jugadorId);
  j.cantTransacc++;

  if (fecha < j.fechaPrimera) j.fechaPrimera = fecha;
  if (fecha > j.fechaUltima)  j.fechaUltima  = fecha;

  const dia = fecha.toISOString().split('T')[0];
  j.diasActivo.add(dia);

  const montoAbs = Math.abs(monto);

  if (operacion.includes('cargo') || operacion.includes('deposit') || monto < 0) {
    j.totalDepositos += montoAbs;
  } else if (operacion.includes('retiro') || operacion.includes('withdraw') || monto > 0) {
    j.totalRetiros += montoAbs;
  }
  j.totalApuestado += montoAbs;
}

// Convertir Sets a números y calcular campos derivados
const jugadores = [];
for (const [id, j] of jugadoresMap.entries()) {
  const diasDesdeUltimo   = Math.floor((hoy - j.fechaUltima)   / 86400000);
  const diasDesdePrimero  = Math.floor((hoy - j.fechaPrimera)  / 86400000);
  const cantDiasActivo    = j.diasActivo.size;
  const frecuenciaSemanal = cantDiasActivo / Math.max(diasDesdePrimero / 7, 1);

  jugadores.push({
    id,
    totalDepositos:    Math.round(j.totalDepositos),
    totalRetiros:      Math.round(j.totalRetiros),
    totalApuestado:    Math.round(j.totalApuestado),
    cantTransacciones: j.cantTransacc,
    cantDiasActivo,
    frecuenciaSemanal: parseFloat(frecuenciaSemanal.toFixed(2)),
    diasDesdeUltimo,
    diasDesdePrimero,
    fechaPrimera:      j.fechaPrimera.toISOString().split('T')[0],
    fechaUltima:       j.fechaUltima.toISOString().split('T')[0],
  });
}

console.log(`   Jugadores únicos encontrados: ${jugadores.length}`);

// ── 4. Calcular percentiles para proponer rangos ──────────────────────────────
function percentil(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * sorted.length);
  return sorted[idx] || 0;
}

const depositos = jugadores.map(j => j.totalDepositos).filter(v => v > 0);
const frecuencias = jugadores.map(j => j.frecuenciaSemanal);
const diasInactivo = jugadores.map(j => j.diasDesdeUltimo);

const rangosDeposito = {
  bajo:   { min: 0,                        max: percentil(depositos, 33) },
  medio:  { min: percentil(depositos, 33),  max: percentil(depositos, 66) },
  alto:   { min: percentil(depositos, 66),  max: percentil(depositos, 90) },
  vip:    { min: percentil(depositos, 90),  max: Infinity },
};

const stats = {
  totalJugadores:   jugadores.length,
  depositos: {
    min:   Math.round(Math.min(...depositos)),
    max:   Math.round(Math.max(...depositos)),
    p25:   Math.round(percentil(depositos, 25)),
    p50:   Math.round(percentil(depositos, 50)),
    p75:   Math.round(percentil(depositos, 75)),
    p90:   Math.round(percentil(depositos, 90)),
    promedio: Math.round(depositos.reduce((a,b) => a+b, 0) / depositos.length),
  },
  diasInactivo: {
    p50: Math.round(percentil(diasInactivo, 50)),
    p75: Math.round(percentil(diasInactivo, 75)),
  },
};

// ── 5. Segmentación ────────────────────────────────────────────────────────────
function segmentarActividad(j) {
  if (j.diasDesdeUltimo > 60) return 'inactivo';
  if (j.diasDesdeUltimo > 30) return 'en_riesgo';
  if (j.diasDesdePrimero <= 30) return 'nuevo';
  if (j.frecuenciaSemanal >= 3) return 'frecuente';
  if (j.frecuenciaSemanal >= 1) return 'regular';
  return 'ocasional';
}

function segmentarMonto(deposito) {
  if (deposito >= rangosDeposito.vip.min)  return 'vip';
  if (deposito >= rangosDeposito.alto.min) return 'alto';
  if (deposito >= rangosDeposito.medio.min)return 'medio';
  return 'bajo';
}

const jugadoresSegmentados = jugadores.map(j => ({
  ...j,
  segmento_actividad: segmentarActividad(j),
  segmento_monto:     segmentarMonto(j.totalDepositos),
}));

// ── 6. Distribución de segmentos ──────────────────────────────────────────────
const distActividad = {};
const distMonto = {};
jugadoresSegmentados.forEach(j => {
  distActividad[j.segmento_actividad] = (distActividad[j.segmento_actividad] || 0) + 1;
  distMonto[j.segmento_monto]         = (distMonto[j.segmento_monto] || 0) + 1;
});

// ── 7. Resultado final ────────────────────────────────────────────────────────
const segmentosPropuestos = {
  generadoEl: new Date().toISOString(),
  stats,
  rangos: {
    monto: {
      bajo:  { min: 0,                            max: Math.round(rangosDeposito.bajo.max),  descripcion: 'Apostadores bajos' },
      medio: { min: Math.round(rangosDeposito.medio.min), max: Math.round(rangosDeposito.medio.max), descripcion: 'Apostadores medios' },
      alto:  { min: Math.round(rangosDeposito.alto.min),  max: Math.round(rangosDeposito.alto.max),  descripcion: 'Apostadores altos' },
      vip:   { min: Math.round(rangosDeposito.vip.min),   max: null,                          descripcion: 'VIP' },
    },
    actividad: {
      nuevo:      { dias_desde_primero: '0-30',     descripcion: 'Primer mes de actividad' },
      frecuente:  { sesiones_semana: '≥3',          descripcion: 'Juega 3+ veces por semana' },
      regular:    { sesiones_semana: '1-3',         descripcion: 'Juega 1-3 veces por semana' },
      ocasional:  { sesiones_semana: '<1',          descripcion: 'Juega menos de 1 vez por semana' },
      en_riesgo:  { dias_inactivo: '31-60',         descripcion: 'Sin actividad entre 31 y 60 días' },
      inactivo:   { dias_inactivo: '>60',           descripcion: 'Sin actividad hace más de 60 días' },
    },
  },
  distribucion: { actividad: distActividad, monto: distMonto },
};

// ── 8. Guardar archivos ───────────────────────────────────────────────────────
fs.writeFileSync(
  path.join(OUT_DIR, 'analisis_jugadores.json'),
  JSON.stringify(jugadoresSegmentados, null, 2)
);
fs.writeFileSync(
  path.join(OUT_DIR, 'segmentos_propuestos.json'),
  JSON.stringify(segmentosPropuestos, null, 2)
);

// CSV con segmentos
const csvHeaders = ['id', 'agente', 'totalDepositos', 'cantDiasActivo', 'frecuenciaSemanal',
                    'diasDesdeUltimo', 'fechaPrimera', 'fechaUltima',
                    'segmento_actividad', 'segmento_monto'];
const csvRows = [
  csvHeaders.join(','),
  ...jugadoresSegmentados.map(j =>
    csvHeaders.map(h => `"${String(j[h] ?? '').replace(/"/g,'""')}"`).join(',')
  ),
];
fs.writeFileSync(path.join(OUT_DIR, 'jugadores_segmentados.csv'), csvRows.join('\n'), 'utf8');

// ── 9. Imprimir resumen ───────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════');
console.log('📈 ESTADÍSTICAS DEL HISTORIAL (últimos 6 meses)');
console.log('══════════════════════════════════════════════');
console.log(`Jugadores únicos:    ${jugadores.length}`);
console.log(`Total transacciones: ${rowsFiltradas.length}`);
console.log(`\nDepósitos totales:`);
console.log(`  Mínimo:   $${stats.depositos.min.toLocaleString('es-AR')} ARS`);
console.log(`  Promedio: $${stats.depositos.promedio.toLocaleString('es-AR')} ARS`);
console.log(`  Mediana:  $${stats.depositos.p50.toLocaleString('es-AR')} ARS`);
console.log(`  Máximo:   $${stats.depositos.max.toLocaleString('es-AR')} ARS`);

console.log('\n══════════════════════════════════════════════');
console.log('💡 RANGOS PROPUESTOS — MONTO DE APUESTA');
console.log('══════════════════════════════════════════════');
const r = segmentosPropuestos.rangos.monto;
console.log(`  🟢 Bajo   → $0 – $${r.bajo.max.toLocaleString('es-AR')} ARS`);
console.log(`  🟡 Medio  → $${r.medio.min.toLocaleString('es-AR')} – $${r.medio.max.toLocaleString('es-AR')} ARS`);
console.log(`  🟠 Alto   → $${r.alto.min.toLocaleString('es-AR')} – $${r.alto.max.toLocaleString('es-AR')} ARS`);
console.log(`  🔴 VIP    → +$${r.vip.min.toLocaleString('es-AR')} ARS`);

console.log('\n══════════════════════════════════════════════');
console.log('⏱️  RANGOS PROPUESTOS — ACTIVIDAD');
console.log('══════════════════════════════════════════════');
console.log(`  🆕 Nuevo       → primer depósito hace < 30 días`);
console.log(`  ⚡ Frecuente   → juega 3+ veces/semana`);
console.log(`  ✅ Regular     → juega 1-3 veces/semana`);
console.log(`  😴 Ocasional   → menos de 1 vez/semana`);
console.log(`  ⚠️  En riesgo  → sin actividad 31-60 días`);
console.log(`  ❌ Inactivo    → sin actividad +60 días`);

console.log('\n══════════════════════════════════════════════');
console.log('📊 DISTRIBUCIÓN ACTUAL');
console.log('══════════════════════════════════════════════');
console.log('Por actividad:');
Object.entries(distActividad).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => {
  const pct = ((v/jugadores.length)*100).toFixed(1);
  console.log(`  ${k.padEnd(12)}: ${v.toString().padStart(6)} jugadores (${pct}%)`);
});
console.log('\nPor monto:');
Object.entries(distMonto).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => {
  const pct = ((v/jugadores.length)*100).toFixed(1);
  console.log(`  ${k.padEnd(12)}: ${v.toString().padStart(6)} jugadores (${pct}%)`);
});

console.log('\n══════════════════════════════════════════════');
console.log('💾 Archivos generados:');
console.log('   exports/analisis_jugadores.json');
console.log('   exports/segmentos_propuestos.json');
console.log('   exports/jugadores_segmentados.csv');
console.log('══════════════════════════════════════════════');
