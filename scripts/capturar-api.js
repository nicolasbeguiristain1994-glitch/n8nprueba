/**
 * Capturador de API - Historial extendido
 *
 * Cada sesión guarda solo los endpoints NUEVOS en un archivo chico
 * (exports/sesiones/sesion_TIMESTAMP.json), evitando el límite de
 * string de Node al trabajar con archivos de cientos de MB.
 *
 * procesar-caja.js lee todos los archivos de sesiones y los une.
 *
 * Uso:
 *   node scripts/capturar-api.js
 */

const { chromium } = require('playwright');
const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

const CONFIG = {
  frontendUrl: 'https://agentes.zeuscasino.fun/',
  outputDir:   path.join(__dirname, '../exports'),
  sesionesDir: path.join(__dirname, '../exports/sesiones'),
  profileDir:  path.join(__dirname, '../exports/.browser-profile'),
};

const AGENTES    = ['betcoin', 'bigwin', 'farabet', 'ofizeus', 'royal'];
const MESES_ATRAS = 12; // objetivo: abr 2025 – abr 2026

// ── Leer todos los archivos de sesiones acumulados ───────────────────────────
function leerTodasLasSesiones() {
  const dir = CONFIG.sesionesDir;
  if (!fs.existsSync(dir)) return {};
  const archivos = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  const merged = {};
  for (const archivo of archivos) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, archivo), 'utf8'));
      for (const [url, arr] of Object.entries(data)) {
        if (!merged[url]) merged[url] = arr;
      }
    } catch (_) {}
  }
  return merged;
}

// ── Analizar cobertura existente ──────────────────────────────────────────────
function analizarCobertura() {
  const datos = leerTodasLasSesiones();
  // También leer el archivo legado si existe
  const legadoPath = path.join(CONFIG.outputDir, 'api_caja_capturada.json');
  if (fs.existsSync(legadoPath)) {
    try {
      const legado = JSON.parse(fs.readFileSync(legadoPath, 'utf8'));
      for (const [url, arr] of Object.entries(legado)) {
        if (!datos[url]) datos[url] = arr;
      }
    } catch (_) {}
  }

  const cobertura = {};
  for (const [url, arr] of Object.entries(datos)) {
    if (!url.includes('movimiento-fichas') || !Array.isArray(arr)) continue;
    const m = url.match(/username=([^&]+)/);
    const ag = m ? m[1] : null;
    if (!ag) continue;
    if (!cobertura[ag]) cobertura[ag] = new Set();
    for (const t of arr) if (t.fecha) cobertura[ag].add(t.fecha.substring(0, 7));
  }
  return cobertura;
}

// ── URLs ya capturadas ────────────────────────────────────────────────────────
function urlsYaCapturadas() {
  const datos = leerTodasLasSesiones();
  const legadoPath = path.join(CONFIG.outputDir, 'api_caja_capturada.json');
  if (fs.existsSync(legadoPath)) {
    try {
      const legado = JSON.parse(fs.readFileSync(legadoPath, 'utf8'));
      for (const [url, arr] of Object.entries(legado)) {
        if (!datos[url]) datos[url] = arr;
      }
    } catch (_) {}
  }
  return new Set(Object.keys(datos).filter(u => u.includes('movimiento-fichas')));
}

// ── Generar lista de meses faltantes ─────────────────────────────────────────
function mesesFaltantes(cobertura) {
  const hoy = new Date();
  const meses = [];
  for (let i = 0; i < MESES_ATRAS; i++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
    meses.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const faltantes = {};
  for (const agente of AGENTES) {
    const cubiertos = cobertura[agente] || new Set();
    faltantes[agente] = meses.filter(m => !cubiertos.has(m)).sort();
  }
  return faltantes;
}

// ── Mostrar estado de cobertura ───────────────────────────────────────────────
function mostrarCobertura(cobertura) {
  const hoy = new Date();
  const todos = [];
  for (let i = 0; i < MESES_ATRAS; i++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
    todos.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  todos.sort();

  console.log('\n📊 COBERTURA ACTUAL:');
  console.log('  Agente    ' + todos.map(m => m.substring(2)).join(' '));
  for (const agente of AGENTES) {
    const cubiertos = cobertura[agente] || new Set();
    const fila = todos.map(m => cubiertos.has(m) ? '✅' : '❌').join('   ');
    console.log(`  ${agente.padEnd(10)}${fila}`);
  }

  // Contar jugadores únicos
  const datos = leerTodasLasSesiones();
  const legadoPath = path.join(CONFIG.outputDir, 'api_caja_capturada.json');
  if (fs.existsSync(legadoPath)) {
    try {
      const legado = JSON.parse(fs.readFileSync(legadoPath, 'utf8'));
      for (const [url, arr] of Object.entries(legado)) {
        if (!datos[url]) datos[url] = arr;
      }
    } catch (_) {}
  }
  const seen = new Set();
  for (const [url, arr] of Object.entries(datos)) {
    if (!url.includes('movimiento-fichas') || !Array.isArray(arr)) continue;
    for (const t of arr) if (t.username && t.roles?.includes('ROLE_APOSTADOR')) seen.add(t.username);
  }
  console.log(`\n  👥 Jugadores únicos capturados hasta ahora: ${seen.size.toLocaleString('es-AR')}`);
  console.log('');
}

async function main() {
  fs.mkdirSync(CONFIG.sesionesDir, { recursive: true });

  const cobertura    = analizarCobertura();
  const faltantes    = mesesFaltantes(cobertura);
  const urlsExistentes = urlsYaCapturadas();

  const todosLosMesesFaltantes = [
    ...new Set(Object.values(faltantes).flat())
  ].sort().reverse();

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  CAPTURADOR DE HISTORIAL EXTENDIDO - ZeusCasino');
  console.log('══════════════════════════════════════════════════════════════');

  mostrarCobertura(cobertura);

  if (todosLosMesesFaltantes.length === 0) {
    console.log('🎉 ¡Cobertura completa de 12 meses! Ahora corrés:');
    console.log('   node scripts/procesar-caja.js');
    return;
  }

  const bloques = [];
  for (let i = 0; i < todosLosMesesFaltantes.length; i += 2) {
    const desde = todosLosMesesFaltantes[Math.min(i + 1, todosLosMesesFaltantes.length - 1)];
    const hasta  = todosLosMesesFaltantes[i];
    bloques.push({ desde, hasta });
  }

  console.log(`⚠️  Períodos faltantes: ${todosLosMesesFaltantes.length} meses sin capturar`);
  console.log('\n📋 INSTRUCCIONES PARA ESTA SESIÓN:');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  console.log('  En el panel: Reportes Financieros → Caja → expandí peaky');
  console.log('');
  console.log('  Para cada bloque de 2 meses:');
  console.log('  ┌─────────────────────────────────────────────────────┐');
  console.log('  │  1. Cambiá el filtro de fecha al rango indicado     │');
  console.log('  │  2. Hacé click en betcoin → esperá que cargue       │');
  console.log('  │  3. Hacé click en bigwin  → esperá que cargue       │');
  console.log('  │  4. Hacé click en farabet → esperá que cargue       │');
  console.log('  │  5. Hacé click en ofizeus → esperá que cargue       │');
  console.log('  │  6. Hacé click en royal   → esperá que cargue       │');
  console.log('  └─────────────────────────────────────────────────────┘');
  console.log('');
  console.log('  BLOQUES A CAPTURAR (de más reciente a más antiguo):');
  console.log('');

  const nombres = ['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  bloques.forEach((b, idx) => {
    const [dY, dM] = b.desde.split('-');
    const [hY, hM] = b.hasta.split('-');
    const diasUltimo = new Date(+hY, +hM, 0).getDate();
    console.log(`  ${String(idx + 1).padStart(2)}. Desde 01/${dM}/${dY}  hasta  ${diasUltimo}/${hM}/${hY}  (${nombres[+dM]} ${dY} – ${nombres[+hM]} ${hY})`);
  });

  console.log('');
  console.log('  ⚠️  De a 2 meses para que no se tilde el panel.');
  console.log('  Podés cerrar y volver a abrir el script entre sesiones.');
  console.log('  Presioná ENTER cuando termines esta sesión.');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');

  // ── Abrir browser ────────────────────────────────────────────────────────────
  const browser = await chromium.launchPersistentContext(CONFIG.profileDir, {
    headless: false,
    viewport: { width: 1400, height: 900 },
  });

  const page = browser.pages()[0] || await browser.newPage();
  const capturado = {}; // solo los endpoints de esta sesión
  let totalCapturado = 0;

  browser.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('local-admin2.zeuscasino.fun')) return;
    if (res.status() !== 200) return;

    try {
      const json = await res.json();

      if (Array.isArray(json)) {
        if (!capturado[url]) capturado[url] = [];
        capturado[url].push(...json);
        totalCapturado += json.length;
      } else if (json.data && Array.isArray(json.data)) {
        if (!capturado[url]) capturado[url] = [];
        capturado[url].push(...json.data);
        totalCapturado += json.data.length;
      } else {
        capturado[url] = json;
      }

      const short = url.replace('https://local-admin2.zeuscasino.fun/api', '').split('?')[0];
      process.stdout.write(`\r  📡 ${Object.keys(capturado).length} endpoints | ${totalCapturado.toLocaleString('es-AR')} filas | Último: ${short}          `);
    } catch (_) {}
  });

  console.log('🌐 Abriendo panel...\n');
  await page.goto(CONFIG.frontendUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  console.log('  Navegá en el browser. Presioná ENTER acá cuando termines.\n');

  await new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', () => { rl.close(); resolve(); });
  });

  console.log('\n\n✅ Guardando sesión...');

  // ── Guardar SOLO los endpoints nuevos de esta sesión ─────────────────────────
  const soloNuevos = {};
  let nuevosEndpoints = 0;
  for (const [url, data] of Object.entries(capturado)) {
    if (!url.includes('movimiento-fichas')) continue; // ignorar otros endpoints
    if (!urlsExistentes.has(url)) {
      soloNuevos[url] = data;
      nuevosEndpoints++;
    }
  }

  if (nuevosEndpoints > 0) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const sesionPath = path.join(CONFIG.sesionesDir, `sesion_${timestamp}.json`);
    fs.writeFileSync(sesionPath, JSON.stringify(soloNuevos));
    console.log(`  💾 Guardado: sesiones/sesion_${timestamp}.json (${nuevosEndpoints} endpoints nuevos)`);
  } else {
    console.log('  ℹ️  No hubo endpoints nuevos de movimiento-fichas en esta sesión.');
  }

  // ── Mostrar nueva cobertura ───────────────────────────────────────────────────
  const coberturaActualizada = analizarCobertura();
  mostrarCobertura(coberturaActualizada);

  const faltantesActualizados = mesesFaltantes(coberturaActualizada);
  const totalFaltantes = [...new Set(Object.values(faltantesActualizados).flat())].length;

  if (totalFaltantes > 0) {
    console.log(`⚠️  Todavía faltan ${totalFaltantes} meses. Volvé a correr:`);
    console.log('   node scripts/capturar-api.js\n');
  } else {
    console.log('🎉 ¡Cobertura completa! Ahora corrés:');
    console.log('   node scripts/procesar-caja.js');
    console.log('   node scripts/cargar-casino-players.js "postgresql://..."');
    console.log('   node scripts/crear-listas-casino.js "postgresql://..." --repoblar\n');
  }

  await browser.close();
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
