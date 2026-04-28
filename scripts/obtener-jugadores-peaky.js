/**
 * Obtiene los jugadores bajo los agentes objetivo de peaky
 * Usa el browser autenticado para llamar a la API con cada userId
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
  apiBase: 'https://local-admin2.zeuscasino.fun/api',
  outputDir: path.join(__dirname, '../exports'),
  profileDir: path.join(__dirname, '../exports/.browser-profile'),
};

// Agentes objetivo bajo peaky
const AGENTES_OBJETIVO = [
  { nombre: 'betcoin',  id: 72770  },
  { nombre: 'bigwin',   id: 12233  },
  { nombre: 'farabet',  id: 563863 },
  { nombre: 'ofizeus',  id: 72758  },
  { nombre: 'royal',    id: 3133731 },
];

async function main() {
  const browser = await chromium.launchPersistentContext(CONFIG.profileDir, {
    headless: true,
  });

  const page = browser.pages()[0] || await browser.newPage();

  console.log('🌐 Cargando panel...');
  await page.goto(CONFIG.frontendUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  // Verificar sesión
  const sessionOk = await page.evaluate(async (apiBase) => {
    try {
      const res = await fetch(`${apiBase}/user/balance`, { credentials: 'include' });
      return res.status === 200;
    } catch { return false; }
  }, CONFIG.apiBase);

  if (!sessionOk) {
    console.log('❌ Sesión no activa. Corré primero: node scripts/scrape-zeus-users.js');
    await browser.close();
    return;
  }
  console.log('✅ Sesión activa\n');

  const todosJugadores = [];
  const resultadoPorAgente = {};

  for (const agente of AGENTES_OBJETIVO) {
    console.log(`\n📋 Obteniendo jugadores de: ${agente.nombre} (id=${agente.id})`);

    // Probar varios endpoints con el userId del agente
    const endpoints = [
      `/user/new_jerarquia?userId=${agente.id}`,
      `/user/capitales?userId=${agente.id}`,
      `/user/list?userId=${agente.id}`,
      `/user/saldos?userId=${agente.id}`,
    ];

    let encontrado = false;

    for (const ep of endpoints) {
      const result = await page.evaluate(async ({ base, endpoint }) => {
        try {
          const res = await fetch(`${base}${endpoint}`, {
            credentials: 'include',
            headers: { Accept: 'application/json' },
          });
          const text = await res.text();
          return { status: res.status, body: text };
        } catch (e) {
          return { status: 0, error: e.message };
        }
      }, { base: CONFIG.apiBase, endpoint: ep });

      if (result.status === 200 && result.body) {
        try {
          const json = JSON.parse(result.body);

          // Extraer array de usuarios
          let items = [];
          if (Array.isArray(json)) items = json;
          else if (json.data && Array.isArray(json.data)) items = json.data;
          else if (json.users && Array.isArray(json.users)) items = json.users;

          // Aplanar árbol si tiene "hijos"
          if (items.length > 0 && items[0].hijos !== undefined) {
            function aplanar(nodo) {
              const r = [{ id: nodo.id, username: nodo.name || nodo.username, enabled: nodo.enabled }];
              for (const h of (nodo.hijos || [])) r.push(...aplanar(h));
              return r;
            }
            items = items.flatMap(n => aplanar(n));
          }

          console.log(`  [${result.status}] ${ep} → ${items.length} items`);
          if (items.length > 0) {
            console.log(`  Campos: ${Object.keys(items[0]).join(', ')}`);
            console.log(`  Ejemplo: ${JSON.stringify(items[0])}`);

            resultadoPorAgente[agente.nombre] = items.map(u => ({
              ...u,
              agente: agente.nombre,
              agente_id: agente.id,
            }));
            todosJugadores.push(...resultadoPorAgente[agente.nombre]);
            encontrado = true;
            break;
          }
        } catch (_) {}
      } else {
        console.log(`  [${result.status}] ${ep}`);
      }
    }

    if (!encontrado) {
      console.log(`  ⚠️  Sin datos para ${agente.nombre}`);
    }
  }

  // Guardar resultados
  const jsonPath = path.join(CONFIG.outputDir, 'jugadores_por_agente.json');
  fs.writeFileSync(jsonPath, JSON.stringify(resultadoPorAgente, null, 2));
  console.log(`\n💾 JSON: ${jsonPath}`);

  if (todosJugadores.length > 0) {
    const headers = [...new Set(todosJugadores.flatMap(j => Object.keys(j)))];
    const csvRows = [
      headers.join(','),
      ...todosJugadores.map(j =>
        headers.map(h => `"${String(j[h] ?? '').replace(/"/g, '""')}"`).join(',')
      ),
    ];
    const csvPath = path.join(CONFIG.outputDir, 'jugadores_por_agente.csv');
    fs.writeFileSync(csvPath, csvRows.join('\n'), 'utf8');
    console.log(`💾 CSV: ${csvPath}`);
    console.log(`\n✅ Total: ${todosJugadores.length} usuarios encontrados`);
  }

  await browser.close();
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
