#!/usr/bin/env node
/**
 * import-workflows.mjs
 * Importa los workflows desde exports/ directamente a n8n (local y/o Railway).
 *
 * Uso:
 *   node scripts/ops/import-workflows.mjs              # ambas instancias
 *   node scripts/ops/import-workflows.mjs --local      # solo local
 *   node scripts/ops/import-workflows.mjs --railway    # solo Railway
 *   node scripts/ops/import-workflows.mjs --dry-run    # sin ejecutar
 */

import fs   from 'fs';
import path from 'path';

// ─── Cargar .env ──────────────────────────────────────────────────────────────
(function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!(k in process.env)) process.env[k] = v;
  }
})();

// ─── Config ───────────────────────────────────────────────────────────────────
const DRY_RUN       = process.argv.includes('--dry-run');
const ONLY_LOCAL    = process.argv.includes('--local');
const ONLY_RAILWAY  = process.argv.includes('--railway');
const EXPORTS_DIR   = path.resolve('./exports');

const INSTANCES = [];
if (!ONLY_RAILWAY) INSTANCES.push({
  name:   'LOCAL',
  url:    process.env.N8N_LOCAL_URL || 'http://localhost:5678',
  apiKey: process.env.N8N_LOCAL_API_KEY,
});
if (!ONLY_LOCAL) INSTANCES.push({
  name:   'RAILWAY',
  url:    process.env.N8N_RAILWAY_URL || 'https://n8n-production-cec3.up.railway.app',
  apiKey: process.env.N8N_RAILWAY_API_KEY,
});

// Orden de importación (por dependencia)
const IMPORT_ORDER = [
  'WF-012-Line-Selector',
  'WF-015-Phone-Validator',
  'WF-007-Send-WhatsApp-Message',
  'WF-006_Batch_Send_Dispatcher',
  'WF-008-Webhook-Inbound-WhatsApp',
  'WF-010-Human-Handoff',
  'WF-009-Intent-Router-And-AutoReply',
  'WF-011-Sequence-Engine',
  'WF-013-Line-Health-Monitor',
  'WF-014-Contact-Import',
  'WF-016-Metrics-Aggregator',
  'WF-017-Daily-Report',
  'WF-018-Inactivity-Trigger',
  'WF-019-Retry-Failed-Messages',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
const log = {
  section: (m) => console.log(`\n${'═'.repeat(58)}\n  ${m}\n${'═'.repeat(58)}`),
  ok:      (m) => console.log(`  ✓  ${m}`),
  info:    (m) => console.log(`  ℹ  ${m}`),
  warn:    (m) => console.log(`  ⚠  ${m}`),
  error:   (m) => console.error(`  ✗  ${m}`),
  step:    (m) => console.log(`\n  ▶  ${m}`),
};

async function n8nReq(url, apiKey, method, endpoint, body = null) {
  const opts = {
    method,
    headers: { 'X-N8N-API-KEY': apiKey, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const res = await fetch(`${url}/api/v1${endpoint}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, data });
  return data;
}

function cleanWorkflow(raw) {
  // Quita campos runtime que n8n no acepta en POST/PUT
  // tags es read-only en la API — se asignan aparte si se necesitan
  return {
    name:        raw.name,
    nodes:       (raw.nodes || []).map(({ credentials: _c, ...n }) => n),
    connections: raw.connections || {},
    settings:    { executionOrder: raw.settings?.executionOrder ?? 'v1' },
  };
}

function findExportFile(wfName) {
  // Busca el archivo por nombre exacto o prefijo
  const files = fs.readdirSync(EXPORTS_DIR).filter(f => f.endsWith('.json'));
  // Coincidencia exacta sin extensión
  const exact = files.find(f => f.replace('.json', '') === wfName);
  if (exact) return path.join(EXPORTS_DIR, exact);
  // Coincidencia por prefijo (ej: WF-006 matchea WF-006_Batch...)
  const byPrefix = files.find(f => f.startsWith(wfName));
  if (byPrefix) return path.join(EXPORTS_DIR, byPrefix);
  return null;
}

// ─── Importar a una instancia ─────────────────────────────────────────────────
async function importToInstance(instance, workflows) {
  log.section(`Importando a ${instance.name} (${instance.url})`);

  if (!instance.apiKey) {
    log.error(`API key no configurada para ${instance.name}. Saltando.`);
    return { ok: 0, updated: 0, skipped: 0, error: 0 };
  }

  // Obtener workflows existentes
  let existing = [];
  try {
    const res = await n8nReq(instance.url, instance.apiKey, 'GET', '/workflows?limit=100');
    existing = res.data ?? [];
    log.info(`Workflows existentes: ${existing.length}`);
  } catch (err) {
    log.error(`No se puede conectar a ${instance.name}: ${err.message}`);
    return { ok: 0, updated: 0, skipped: 0, error: 0 };
  }

  const byName = Object.fromEntries(existing.map(w => [w.name, w]));
  const stats  = { ok: 0, updated: 0, skipped: 0, error: 0 };

  for (const wfKey of workflows) {
    const filePath = findExportFile(wfKey);

    if (!filePath) {
      log.warn(`${wfKey} — archivo no encontrado en exports/`);
      stats.skipped++;
      continue;
    }

    const raw  = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const body = cleanWorkflow(raw);

    log.step(`${body.name}`);
    log.info(`Archivo: ${path.basename(filePath)}`);

    if (DRY_RUN) {
      log.warn('DRY RUN — no importado');
      stats.skipped++;
      continue;
    }

    const duplicate = byName[body.name];

    try {
      if (duplicate) {
        // Actualizar existente
        await n8nReq(instance.url, instance.apiKey, 'PUT', `/workflows/${duplicate.id}`, body);
        log.ok(`Actualizado (id: ${duplicate.id})`);
        stats.updated++;
      } else {
        // Crear nuevo
        const created = await n8nReq(instance.url, instance.apiKey, 'POST', '/workflows', body);
        log.ok(`Importado (id: ${created.id})`);
        stats.ok++;
      }
    } catch (err) {
      log.error(`Error: ${err.message}`);
      if (err.data?.message) log.error(`  → ${err.data.message}`);
      stats.error++;
    }

    // Pausa mínima para no saturar la API
    await new Promise(r => setTimeout(r, 300));
  }

  return stats;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  log.section('WhatsApp Platform — Import Workflows to n8n');

  if (DRY_RUN) log.warn('Modo DRY RUN — no se modificará nada');

  // Leer archivos disponibles
  const available = fs.readdirSync(EXPORTS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));

  log.info(`Archivos en exports/: ${available.length}`);
  log.info(`Workflows a importar: ${IMPORT_ORDER.length}`);

  const totalStats = { ok: 0, updated: 0, skipped: 0, error: 0 };

  for (const instance of INSTANCES) {
    const stats = await importToInstance(instance, IMPORT_ORDER);
    totalStats.ok      += stats.ok;
    totalStats.updated += stats.updated;
    totalStats.skipped += stats.skipped;
    totalStats.error   += stats.error;
  }

  log.section('Resultado Final');
  log.ok(`  Creados:     ${totalStats.ok}`);
  if (totalStats.updated) log.ok(`  Actualizados: ${totalStats.updated}`);
  if (totalStats.skipped) log.warn(`  Saltados:    ${totalStats.skipped}`);
  if (totalStats.error)   log.error(`  Errores:     ${totalStats.error}`);

  if (!totalStats.error && !DRY_RUN) {
    console.log(`
  ─────────────────────────────────────────────────────
  Próximos pasos:
  1. En n8n: asignar credenciales a los nodos Postgres,
     HTTP Auth (Evolution API) y Slack en cada workflow.
  2. Activar en orden: WF-012 → WF-007 → resto.
  3. Conectar QR de las líneas en Evolution API.
  4. Ver guía completa: docs/runbooks/import-workflows-n8n.md
  ─────────────────────────────────────────────────────`);
  }
}

main().catch(err => {
  console.error('\n  ✗ Error inesperado:', err.message);
  process.exit(1);
});
