#!/usr/bin/env node
/**
 * migrate-workflows.mjs
 * Exporta workflows desde n8n local e importa al n8n de Railway.
 * Requiere Node 18+ (fetch nativo, readline/promises).
 *
 * Uso:
 *   node scripts/ops/migrate-workflows.mjs
 *
 * Variables de entorno (ver .env.example):
 *   N8N_LOCAL_API_KEY     API key del n8n local
 *   N8N_RAILWAY_API_KEY   API key del n8n de Railway
 *   N8N_LOCAL_URL         (opcional) default: http://localhost:5678
 *   N8N_RAILWAY_URL       (requerido) URL de tu instancia n8n en Railway o similar
 */

import fs   from 'fs';
import path from 'path';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

// ─── Carga de .env ────────────────────────────────────────────────────────────

(function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  console.log(`  [loadDotEnv] cwd:     ${process.cwd()}`);
  console.log(`  [loadDotEnv] envPath: ${envPath}`);

  if (!fs.existsSync(envPath)) {
    console.warn('  ⚠  Archivo .env no encontrado — se usarán las variables del shell si existen.');
    return;
  }

  console.log('  [loadDotEnv] Archivo .env encontrado. Parseando...');
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  const loaded = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Ignorar líneas vacías y comentarios
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key   = trimmed.slice(0, eqIndex).trim();
    // Remover comillas simples o dobles opcionales del valor
    const value = trimmed.slice(eqIndex + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    // No sobreescribir si ya viene del shell
    if (!(key in process.env)) {
      process.env[key] = value;
      loaded.push({ key, source: '.env' });
    } else {
      loaded.push({ key, source: 'shell (no pisado)' });
    }
  }

  console.log('  [loadDotEnv] Variables cargadas:');
  for (const { key, source } of loaded) {
    const val = process.env[key] ?? '';
    const preview = val.length > 0 ? val.slice(0, 10) + (val.length > 10 ? '…' : '') : '(vacío)';
    console.log(`    ${key.padEnd(25)} = "${preview}"  [${source}]`);
  }
})();

// ─── Configuración ────────────────────────────────────────────────────────────

const LOCAL_URL   = process.env.N8N_LOCAL_URL || 'http://localhost:5678';
const RAILWAY_URL = process.env.N8N_RAILWAY_URL;

const LOCAL_API_KEY   = process.env.N8N_LOCAL_API_KEY;
const RAILWAY_API_KEY = process.env.N8N_RAILWAY_API_KEY;

// Todos los workflows de la plataforma, en orden de dependencia
const TARGET_WORKFLOWS = [
  'WF-012',  // Line Selector       — base del multi-línea (primero)
  'WF-015',  // Phone Validator      — sub-workflow
  'WF-007',  // Send WhatsApp        — llama a WF-012
  'WF-006',  // Batch Dispatcher     — llama a WF-007
  'WF-008',  // Webhook Inbound      — entrada de mensajes
  'WF-010',  // Human Handoff        — llama a WF-007
  'WF-009',  // Intent Router        — llama a WF-010
  'WF-011',  // Sequence Engine      — llama a WF-007
  'WF-013',  // Line Health Monitor  — autónomo
  'WF-014',  // Contact Import       — llama a WF-015
  'WF-016',  // Metrics Aggregator   — autónomo
  'WF-017',  // Daily Report         — llama a WF-007
  'WF-018',  // Inactivity Trigger   — lanza secuencias
  'WF-019',  // Retry Failed         — llama a WF-007
];
const EXPORTS_DIR = path.resolve('./exports');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const log = {
  info:    (msg) => console.log(`  ℹ  ${msg}`),
  ok:      (msg) => console.log(`  ✓  ${msg}`),
  warn:    (msg) => console.log(`  ⚠  ${msg}`),
  error:   (msg) => console.error(`  ✗  ${msg}`),
  section: (msg) => console.log(`\n${'─'.repeat(60)}\n  ${msg}\n${'─'.repeat(60)}`),
};

function stripRuntimeFields(workflow) {
  // Solo enviar los campos que acepta el endpoint POST/PUT de n8n
  const clean = {
    name:        workflow.name,
    nodes:       workflow.nodes,
    connections: workflow.connections,
    settings:    { executionOrder: workflow.settings?.executionOrder ?? 'v1' },
  };

  // Limpiar nodos: quitar credenciales (IDs distintos en cada instancia)
  if (Array.isArray(clean.nodes)) {
    clean.nodes = clean.nodes.map(({ credentials: _creds, ...node }) => node);
  }

  return clean;
}

async function n8nRequest(baseUrl, apiKey, method, endpoint, body = null) {
  const url = `${baseUrl}/api/v1${endpoint}`;
  const opts = {
    method,
    headers: {
      'X-N8N-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw Object.assign(
      new Error(`HTTP ${res.status} ${res.statusText}`),
      { status: res.status, body: data }
    );
  }
  return data;
}

// Detecta si hay una TTY real disponible para input interactivo
const IS_TTY = process.stdin.isTTY === true;

async function confirm(rl, question) {
  if (!IS_TTY) {
    // Sin TTY (pipes, scripts, CI): sobreescribir automáticamente y avisar
    log.warn(`Sin TTY — sobreescribiendo automáticamente: "${question}"`);
    return true;
  }
  const answer = await rl.question(`  ? ${question} [s/N] `);
  return answer.toLowerCase() === 's';
}

// ─── Validaciones iniciales ───────────────────────────────────────────────────

function validateEnv() {
  const missing = [];
  if (!LOCAL_API_KEY)   missing.push('N8N_LOCAL_API_KEY');
  if (!RAILWAY_API_KEY) missing.push('N8N_RAILWAY_API_KEY');
  if (!RAILWAY_URL)     missing.push('N8N_RAILWAY_URL');
  if (missing.length) {
    console.error(`\n  ✗ Variables de entorno faltantes: ${missing.join(', ')}`);
    console.error('    Copiá .env.example a .env y completá los valores.\n');
    process.exit(1);
  }
}

// ─── Paso 1: Exportar desde local ─────────────────────────────────────────────

async function exportFromLocal() {
  log.section('PASO 1 — Exportar desde n8n local');

  let allWorkflows;
  try {
    const res = await n8nRequest(LOCAL_URL, LOCAL_API_KEY, 'GET', '/workflows?limit=100');
    allWorkflows = res.data ?? res;
  } catch (err) {
    log.error(`No se pudo conectar a n8n local (${LOCAL_URL}): ${err.message}`);
    if (err.cause?.code === 'ECONNREFUSED') {
      log.error('¿Está corriendo n8n en localhost:5678?');
    }
    process.exit(1);
  }

  const matched = allWorkflows.filter(wf =>
    TARGET_WORKFLOWS.some(target => wf.name?.includes(target))
  );

  if (matched.length === 0) {
    log.warn(`No se encontraron workflows con: ${TARGET_WORKFLOWS.join(', ')}`);
    log.info(`Workflows disponibles en local: ${allWorkflows.map(w => w.name).join(', ') || '(ninguno)'}`);
    process.exit(0);
  }

  log.info(`Encontrados ${matched.length} workflows: ${matched.map(w => w.name).join(', ')}`);

  if (!fs.existsSync(EXPORTS_DIR)) {
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    log.info(`Carpeta creada: ${EXPORTS_DIR}`);
  }

  const exported = [];
  for (const wf of matched) {
    try {
      // Obtener el workflow completo (con nodos)
      const full = await n8nRequest(LOCAL_URL, LOCAL_API_KEY, 'GET', `/workflows/${wf.id}`);
      const safeName = wf.name.replace(/[^a-zA-Z0-9_-]/g, '_');
      const filePath = path.join(EXPORTS_DIR, `${safeName}.json`);
      fs.writeFileSync(filePath, JSON.stringify(full, null, 2));
      log.ok(`Exportado: ${wf.name} → ${path.relative('.', filePath)}`);
      exported.push({ workflow: full, filePath });
    } catch (err) {
      log.error(`Error exportando "${wf.name}": ${err.message}`);
    }
  }

  return exported;
}

// ─── Paso 2: Importar a Railway ───────────────────────────────────────────────

async function importToRailway(exported, rl) {
  log.section('PASO 2 — Importar a n8n en Railway');

  // Traer workflows existentes en Railway para detectar duplicados
  let existing = [];
  try {
    const res = await n8nRequest(RAILWAY_URL, RAILWAY_API_KEY, 'GET', '/workflows?limit=100');
    existing = res.data ?? res;
    log.info(`Workflows en Railway: ${existing.length} encontrados`);
  } catch (err) {
    log.error(`No se pudo conectar a Railway (${RAILWAY_URL}): ${err.message}`);
    process.exit(1);
  }

  const existingByName = Object.fromEntries(existing.map(wf => [wf.name, wf]));

  for (const { workflow, filePath } of exported) {
    const clean = stripRuntimeFields(workflow);
    const duplicate = existingByName[workflow.name];

    if (duplicate) {
      log.warn(`"${workflow.name}" ya existe en Railway (id: ${duplicate.id})`);
      const overwrite = await confirm(rl, `¿Sobreescribir "${workflow.name}"?`);

      if (!overwrite) {
        log.info(`Saltado: ${workflow.name}`);
        continue;
      }

      // Sobreescribir via PUT
      try {
        await n8nRequest(RAILWAY_URL, RAILWAY_API_KEY, 'PUT', `/workflows/${duplicate.id}`, clean);
        log.ok(`Actualizado: ${workflow.name} (id: ${duplicate.id})`);
      } catch (err) {
        log.error(`Error actualizando "${workflow.name}": ${err.message}`);
        if (err.body) log.error(`  Detalle: ${JSON.stringify(err.body)}`);
      }
      continue;
    }

    // Crear nuevo via POST
    try {
      const created = await n8nRequest(RAILWAY_URL, RAILWAY_API_KEY, 'POST', '/workflows', clean);
      log.ok(`Importado: ${workflow.name} → id ${created.id}`);
    } catch (err) {
      log.error(`Error importando "${workflow.name}": ${err.message}`);
      if (err.body) log.error(`  Detalle: ${JSON.stringify(err.body)}`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  n8n Workflow Migrator — Local → Railway');

  validateEnv();

  const rl = readline.createInterface({ input, output });

  try {
    const exported = await exportFromLocal();
    if (exported.length === 0) {
      log.warn('No hay workflows para importar.');
      return;
    }
    await importToRailway(exported, rl);
    log.section('Migración finalizada');
  } finally {
    rl.close();
  }
}

main().catch(err => {
  console.error('\n  ✗ Error inesperado:', err.message);
  process.exit(1);
});
