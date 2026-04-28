/**
 * Scraper Zeus Casino - Jugadores por agente (scraping DOM)
 *
 * Flujo:
 *   1. Abre panel
 *   2. Click en peaky (sidebar derecho)
 *   3. Para cada sub-agente: click → tab Jugadores → raspar tabla → paginar
 *
 * Uso: node scripts/scrape-zeus-users.js
 *
 * Output:
 *   exports/jugadores_por_agente.json
 *   exports/jugadores_por_agente.csv
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  frontendUrl: 'https://agentes.zeuscasino.fun/',
  username: 'adminbet',
  password: 'Allblacks23!',
  outputDir: path.join(__dirname, '../exports'),
  profileDir: path.join(__dirname, '../exports/.browser-profile'),
};

const AGENTES_OBJETIVO = ['betcoin', 'bigwin', 'farabet', 'ofizeus', 'royal'];

// Raspa todas las filas de la tabla visible
async function rasparTabla(page) {
  return await page.evaluate(() => {
    const rows = document.querySelectorAll('table tbody tr');
    return Array.from(rows).map(row => {
      const cols = row.querySelectorAll('td');
      return {
        usuario: cols[0]?.innerText?.trim() || '',
        saldo:   cols[1]?.innerText?.trim() || '',
      };
    }).filter(r => r.usuario);
  });
}

// Raspa todas las páginas de la tabla actual
async function rasparTodasLasPaginas(page, nombreAgente) {
  const todos = [];
  let pagina = 1;

  while (true) {
    await page.waitForTimeout(1000);
    const filas = await rasparTabla(page);
    todos.push(...filas);
    console.log(`    Página ${pagina}: ${filas.length} jugadores`);

    // Buscar botón "siguiente" habilitado
    const nextBtn = page.locator('a, button, li').filter({ hasText: /^>$/ }).last();
    const disabled = await nextBtn.evaluate(el =>
      el.classList.contains('disabled') ||
      el.getAttribute('disabled') !== null ||
      el.getAttribute('aria-disabled') === 'true'
    ).catch(() => true);

    if (disabled) break;

    await nextBtn.click();
    await page.waitForTimeout(1500);
    pagina++;

    // Seguridad: máximo 200 páginas
    if (pagina > 200) break;
  }

  return todos;
}

async function main() {
  if (!fs.existsSync(CONFIG.outputDir)) fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  if (!fs.existsSync(CONFIG.profileDir)) fs.mkdirSync(CONFIG.profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(CONFIG.profileDir, {
    headless: false,
    viewport: { width: 1400, height: 900 },
  });
  const page = context.pages()[0] || await context.newPage();

  // ── Login ───────────────────────────────────────────────────────────────
  console.log('🌐 Cargando panel...');
  await page.goto(CONFIG.frontendUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  await Promise.race([
    page.waitForSelector('button', { timeout: 15000 }),
    page.waitForSelector('table',  { timeout: 15000 }),
  ]).catch(() => {});

  const loginBtn = page.locator('button').filter({ hasText: /iniciar sesi[oó]n/i });
  if (await loginBtn.isVisible().catch(() => false)) {
    console.log('🔑 Login...');
    await page.waitForSelector('input', { timeout: 10000 });
    await page.locator('input').nth(0).click({ clickCount: 3 });
    await page.locator('input').nth(0).fill(CONFIG.username);
    await page.locator('input').nth(1).click({ clickCount: 3 });
    await page.locator('input').nth(1).fill(CONFIG.password);
    await loginBtn.click();
    await page.waitForTimeout(6000);
    console.log('✅ Login OK');
  } else {
    console.log('✅ Sesión activa');
  }

  // ── Navegar a Ver Todos ─────────────────────────────────────────────────
  console.log('\n📂 Abriendo sección Usuarios...');
  const verTodos = page.getByText('Ver Todos', { exact: true });
  if (await verTodos.isVisible().catch(() => false)) {
    await verTodos.click();
    await page.waitForTimeout(2000);
  }

  // ── Debug: imprimir nodos de texto del sidebar ─────────────────────────
  const sidebarInfo = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const results = [];
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      if (!text || text.length < 2 || text.length > 40) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      const rect = parent.getBoundingClientRect();
      if (rect.left > window.innerWidth * 0.55 && rect.width > 5 && rect.height > 5) {
        results.push({ text, tag: parent.tagName, x: Math.round(rect.left), y: Math.round(rect.top) });
      }
    }
    return [...new Map(results.map(r => [r.text, r])).values()].slice(0, 50);
  });
  console.log('📋 Texto en sidebar derecho:');
  sidebarInfo.forEach(e => console.log(`  "${e.text}" [${e.tag}] x:${e.x} y:${e.y}`));

  // ── Función para hacer click en el sidebar por texto ───────────────────
  async function clickEnSidebar(texto) {
    // Buscar el nodo de texto y hacer click en su padre
    const coords = await page.evaluate((buscar) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.textContent.trim().toLowerCase() === buscar.toLowerCase()) {
          const parent = node.parentElement;
          const rect = parent.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          }
        }
      }
      return null;
    }, texto);

    if (coords) {
      await page.mouse.click(coords.x, coords.y);
      return true;
    }
    return false;
  }

  // ── Click en peaky ──────────────────────────────────────────────────────
  console.log('\n🌳 Expandiendo peaky...');
  const peakyOk = await clickEnSidebar('peaky');
  if (peakyOk) {
    await page.waitForTimeout(2000);
    console.log('  ✅ peaky clickeado');
  } else {
    console.log('  ⚠️  peaky no encontrado en sidebar');
  }
  await page.screenshot({ path: path.join(CONFIG.outputDir, 'debug_peaky.png') });

  // ── Para cada agente, scrapear sus jugadores ────────────────────────────
  const resultados = {};
  const todosJugadores = [];

  for (const nombreAgente of AGENTES_OBJETIVO) {
    console.log(`\n📋 Agente: ${nombreAgente}`);

    // Click en el agente en el sidebar
    const clickedAgente = await clickEnSidebar(nombreAgente);
    if (!clickedAgente) {
      console.log(`  ⚠️  "${nombreAgente}" no visible en sidebar, saltando`);
      continue;
    }
    await page.waitForTimeout(2000);

    // Click en tab "Jugadores"
    const tabJugadores = page.locator('[role="tab"], button, div').filter({ hasText: /^Jugadores$/ }).first();
    if (await tabJugadores.isVisible().catch(() => false)) {
      await tabJugadores.click();
      console.log('  → Tab Jugadores seleccionado');
      await page.waitForTimeout(2000);
    } else {
      console.log('  ⚠️  Tab Jugadores no encontrado');
    }

    // Esperar que cargue la tabla
    await page.waitForSelector('table tbody tr', { timeout: 8000 }).catch(() => {});

    // Raspar todas las páginas
    console.log('  → Raspando páginas...');
    const jugadores = await rasparTodasLasPaginas(page, nombreAgente);
    console.log(`  ✅ Total: ${jugadores.length} jugadores`);

    if (jugadores.length > 0) {
      resultados[nombreAgente] = jugadores.map(j => ({ ...j, agente: nombreAgente }));
      todosJugadores.push(...resultados[nombreAgente]);
      // Muestra ejemplo
      console.log(`  Ejemplo: ${JSON.stringify(jugadores[0])}`);
    }
  }

  // ── Guardar resultados ──────────────────────────────────────────────────
  console.log(`\n📊 Total jugadores: ${todosJugadores.length}`);

  const jsonPath = path.join(CONFIG.outputDir, 'jugadores_por_agente.json');
  fs.writeFileSync(jsonPath, JSON.stringify(resultados, null, 2));
  console.log(`💾 JSON: ${jsonPath}`);

  if (todosJugadores.length > 0) {
    const headers = ['agente', 'usuario', 'saldo'];
    const rows = [
      headers.join(','),
      ...todosJugadores.map(j =>
        headers.map(h => `"${String(j[h] ?? '').replace(/"/g, '""')}"`).join(',')
      ),
    ];
    const csvPath = path.join(CONFIG.outputDir, 'jugadores_por_agente.csv');
    fs.writeFileSync(csvPath, rows.join('\n'), 'utf8');
    console.log(`💾 CSV: ${csvPath}`);
  }

  await context.close();
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
