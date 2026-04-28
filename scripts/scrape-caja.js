/**
 * Captura los datos de Caja (depósitos y retiros) por jugador
 * usando el browser autenticado para interceptar la API
 *
 * Uso: node scripts/scrape-caja.js
 *
 * Output:
 *   exports/caja_raw.json            → respuestas crudas de la API
 *   exports/jugadores_metricas.json  → métricas por jugador (username, montos, frecuencia)
 *   exports/jugadores_segmentados.csv
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const CONFIG = {
  frontendUrl: 'https://agentes.zeuscasino.fun/',
  apiBase:     'https://local-admin2.zeuscasino.fun/api',
  outputDir:   path.join(__dirname, '../exports'),
  profileDir:  path.join(__dirname, '../exports/.browser-profile'),
};

// Últimos 6 meses
const hoy        = new Date();
const hace6meses = new Date(hoy); hace6meses.setMonth(hoy.getMonth() - 6);
const FECHA_DESDE = hace6meses.toISOString().split('T')[0];
const FECHA_HASTA = hoy.toISOString().split('T')[0];

const AGENTES = [
  { nombre: 'betcoin',  id: 72770   },
  { nombre: 'bigwin',   id: 12233   },
  { nombre: 'farabet',  id: 563863  },
  { nombre: 'ofizeus',  id: 72758   },
  { nombre: 'royal',    id: 72779   },
];

async function main() {
  if (!fs.existsSync(CONFIG.outputDir)) fs.mkdirSync(CONFIG.outputDir, { recursive: true });

  const browser = await chromium.launchPersistentContext(CONFIG.profileDir, {
    headless: false,
    viewport: { width: 1400, height: 900 },
  });
  const page = browser.pages()[0] || await browser.newPage();

  // ── Capturar todas las respuestas de la API ──────────────────────────────
  const apiCapturada = {};
  let cajaEndpoint = null;

  browser.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('local-admin2.zeuscasino.fun')) return;
    if (res.status() !== 200) return;
    try {
      const json = await res.json();
      apiCapturada[url] = json;

      // Detectar el endpoint de caja por sus campos
      const str = JSON.stringify(json);
      if ((str.includes('cuenta_destino') || str.includes('cuentaDestino') ||
           str.includes('DEPOSITO') || str.includes('deposito')) && !cajaEndpoint) {
        cajaEndpoint = url;
        console.log('  🎯 Endpoint CAJA detectado:', url.replace(CONFIG.apiBase, ''));
      }
    } catch (_) {}
  });

  // ── Login si es necesario ────────────────────────────────────────────────
  console.log('🌐 Cargando panel...');
  await page.goto(CONFIG.frontendUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const loginBtn = page.locator('button').filter({ hasText: /iniciar sesi[oó]n/i });
  if (await loginBtn.isVisible().catch(() => false)) {
    console.log('🔑 Login...');
    await page.waitForSelector('input', { timeout: 10000 });
    await page.locator('input').nth(0).fill('adminbet');
    await page.locator('input').nth(1).fill('Allblacks23!');
    await loginBtn.click();
    await page.waitForTimeout(6000);
  } else {
    console.log('✅ Sesión activa');
  }

  // ── Navegar a sección Caja ───────────────────────────────────────────────
  console.log('\n📂 Navegando a Caja...');
  await page.waitForTimeout(2000);

  // Expandir "Reportes Financieros" en el menú izquierdo
  const reportesFinMenu = page.locator('span, a, div, li').filter({ hasText: /Reportes Financieros/i }).first();
  if (await reportesFinMenu.isVisible().catch(() => false)) {
    await reportesFinMenu.click();
    await page.waitForTimeout(1000);
    console.log('  → Reportes Financieros expandido');
  }

  // Click en Caja
  const cajaMenu = page.locator('span, a, li').filter({ hasText: /Caja/i }).first();
  if (await cajaMenu.isVisible().catch(() => false)) {
    await cajaMenu.click();
    await page.waitForTimeout(3000);
    console.log('  → Sección Caja abierta');
  } else {
    // Intentar con texto exacto
    const alt = page.getByText('Caja (depósitos y retiros)', { exact: false }).first();
    if (await alt.isVisible().catch(() => false)) {
      await alt.click();
      await page.waitForTimeout(3000);
    }
  }

  await page.screenshot({ path: path.join(CONFIG.outputDir, 'debug_caja.png') });

  // Mostrar APIs capturadas al navegar
  console.log(`\n📡 APIs capturadas hasta ahora: ${Object.keys(apiCapturada).length}`);
  Object.keys(apiCapturada).forEach(u =>
    console.log('  ', u.replace(CONFIG.apiBase, ''))
  );

  // ── Si detectamos el endpoint, paginarlo ────────────────────────────────
  if (!cajaEndpoint) {
    console.log('\n⚠️  No se detectó el endpoint de Caja automáticamente.');
    console.log('   Guardando todas las APIs capturadas para análisis...');
    fs.writeFileSync(
      path.join(CONFIG.outputDir, 'caja_raw.json'),
      JSON.stringify(apiCapturada, null, 2)
    );
    await browser.close();
    return;
  }

  // Extraer base del endpoint (sin parámetros de paginación)
  const urlBase = new URL(cajaEndpoint);
  console.log(`\n🔄 Paginando endpoint: ${urlBase.pathname}`);

  // Obtener datos para cada agente via API
  const todasLasTransacciones = [];

  for (const agente of AGENTES) {
    console.log(`\n📋 Agente: ${agente.nombre} (id=${agente.id})`);

    let pagina = 0;
    const LIMIT = 500;
    let total = null;
    let acumulado = 0;

    while (true) {
      // Construir URL paginada
      const params = new URLSearchParams(urlBase.searchParams);
      params.set('userId', agente.id);
      params.set('from', FECHA_DESDE);
      params.set('to', FECHA_HASTA);
      params.set('limit', LIMIT);
      params.set('offset', pagina * LIMIT);
      params.set('page', pagina + 1);

      const urlPaginada = `${CONFIG.apiBase}${urlBase.pathname}?${params.toString()}`;

      const res = await page.evaluate(async (url) => {
        try {
          const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
          return { status: r.status, body: await r.text() };
        } catch (e) { return { status: 0, error: e.message }; }
      }, urlPaginada);

      if (res.status !== 200) {
        console.log(`  [${res.status}] Página ${pagina + 1}`);
        break;
      }

      const json = JSON.parse(res.body);
      let items = Array.isArray(json) ? json
                : json.data  ? json.data
                : json.items ? json.items
                : json.rows  ? json.rows
                : null;

      if (!total && json.total) total = json.total;
      if (!items || items.length === 0) break;

      items.forEach(item => {
        item.__agente__ = agente.nombre;
        todasLasTransacciones.push(item);
      });

      acumulado += items.length;
      console.log(`  Página ${pagina + 1}: ${items.length} registros (total: ${acumulado}${total ? '/' + total : ''})`);

      if (items.length < LIMIT) break;
      pagina++;
    }
  }

  console.log(`\n✅ Total transacciones: ${todasLasTransacciones.length}`);

  // Guardar raw
  fs.writeFileSync(
    path.join(CONFIG.outputDir, 'caja_raw.json'),
    JSON.stringify(todasLasTransacciones.slice(0, 100), null, 2) // muestra de 100
  );

  // ── Calcular métricas por jugador ────────────────────────────────────────
  if (todasLasTransacciones.length > 0) {
    console.log('\n📊 Ejemplo de campos:', Object.keys(todasLasTransacciones[0]).join(', '));
    calcularSegmentos(todasLasTransacciones);
  }

  await browser.close();
}

function calcularSegmentos(transacciones) {
  const jugadoresMap = new Map();
  const hoy = new Date();

  for (const t of transacciones) {
    // Detectar campos (pueden variar)
    const username = t.cuenta_destino || t.cuentaDestino || t.player || t.username || t.user || '';
    if (!username) continue;

    const monto = Math.abs(parseFloat(t.monto || t.amount || t.importe || 0));
    const fecha = new Date(t.fecha || t.date || t.created_at || 0);
    const operacion = (t.operacion || t.operación || t.tipo || '').toLowerCase();
    const agente = t.__agente__ || '';

    if (!jugadoresMap.has(username)) {
      jugadoresMap.set(username, {
        username, agente,
        totalCargas: 0, cantCargas: 0,
        totalRetiros: 0,
        fechaPrimera: fecha, fechaUltima: fecha,
        diasActivos: new Set(),
      });
    }

    const j = jugadoresMap.get(username);
    if (fecha < j.fechaPrimera) j.fechaPrimera = fecha;
    if (fecha > j.fechaUltima)  j.fechaUltima  = fecha;
    j.diasActivos.add(fecha.toISOString().split('T')[0]);

    if (operacion.includes('deposit') || operacion.includes('carga') || operacion.includes('cargo')) {
      j.totalCargas += monto;
      j.cantCargas++;
    } else if (operacion.includes('retiro') || operacion.includes('withdraw')) {
      j.totalRetiros += monto;
    }
  }

  const jugadores = [];
  for (const [, j] of jugadoresMap) {
    const diasDesdeUltimo  = Math.floor((hoy - j.fechaUltima)  / 86400000);
    const diasDesdePrimero = Math.floor((hoy - j.fechaPrimera) / 86400000);
    const cantDias = j.diasActivos.size;
    const freqSemanal = cantDias / Math.max(diasDesdePrimero / 7, 1);

    jugadores.push({
      username:      j.username,
      agente:        j.agente,
      totalCargas:   Math.round(j.totalCargas),
      cantCargas:    j.cantCargas,
      diasDesdeUltimo,
      diasDesdePrimero,
      freqSemanal:   parseFloat(freqSemanal.toFixed(2)),
    });
  }

  // Percentiles para rangos
  function pct(arr, p) {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(p / 100 * s.length)] || 0;
  }

  const cargas = jugadores.map(j => j.totalCargas).filter(v => v > 0);
  const p33 = pct(cargas, 33), p66 = pct(cargas, 66), p90 = pct(cargas, 90);

  function segMonto(v) {
    if (v >= p90) return 'vip';
    if (v >= p66) return 'alto';
    if (v >= p33) return 'medio';
    return 'bajo';
  }

  function segActividad(j) {
    if (j.diasDesdeUltimo > 60)    return 'inactivo';
    if (j.diasDesdeUltimo > 30)    return 'en_riesgo';
    if (j.diasDesdePrimero <= 30)  return 'nuevo';
    if (j.freqSemanal >= 3)        return 'frecuente';
    if (j.freqSemanal >= 1)        return 'regular';
    return 'ocasional';
  }

  const segmentados = jugadores.map(j => ({
    ...j,
    seg_monto:     segMonto(j.totalCargas),
    seg_actividad: segActividad(j),
  }));

  // Distribución
  const distMonto = {}, distAct = {};
  segmentados.forEach(j => {
    distMonto[j.seg_monto]     = (distMonto[j.seg_monto]     || 0) + 1;
    distAct[j.seg_actividad]   = (distAct[j.seg_actividad]   || 0) + 1;
  });

  // Guardar
  fs.writeFileSync(
    path.join(CONFIG.outputDir, 'jugadores_metricas.json'),
    JSON.stringify(segmentados, null, 2)
  );

  const headers = ['username', 'agente', 'totalCargas', 'cantCargas', 'freqSemanal',
                   'diasDesdeUltimo', 'seg_monto', 'seg_actividad'];
  const csv = [
    headers.join(','),
    ...segmentados.map(j =>
      headers.map(h => `"${String(j[h] ?? '').replace(/"/g, '""')}"`).join(',')
    ),
  ].join('\n');
  fs.writeFileSync(path.join(CONFIG.outputDir, 'jugadores_segmentados.csv'), csv, 'utf8');

  console.log(`\n══════════════════════════════════`);
  console.log(`✅ Jugadores únicos: ${jugadores.length}`);
  console.log(`\nRANGOS MONTO (últimos 6 meses):`);
  console.log(`  Bajo   → $0 – $${Math.round(p33).toLocaleString('es-AR')}`);
  console.log(`  Medio  → $${Math.round(p33).toLocaleString('es-AR')} – $${Math.round(p66).toLocaleString('es-AR')}`);
  console.log(`  Alto   → $${Math.round(p66).toLocaleString('es-AR')} – $${Math.round(p90).toLocaleString('es-AR')}`);
  console.log(`  VIP    → +$${Math.round(p90).toLocaleString('es-AR')}`);
  console.log(`\nDISTRIBUCIÓN:`);
  Object.entries(distMonto).forEach(([k,v]) => console.log(`  ${k}: ${v} jugadores`));
  Object.entries(distAct).forEach(([k,v]) => console.log(`  ${k}: ${v} jugadores`));
  console.log(`\n💾 exports/jugadores_segmentados.csv`);
  console.log(`💾 exports/jugadores_metricas.json`);
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
