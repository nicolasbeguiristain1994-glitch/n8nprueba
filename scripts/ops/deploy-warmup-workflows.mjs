#!/usr/bin/env node
/**
 * deploy-warmup-workflows.mjs
 * Despliega los 4 workflows de warmup desde los JSON del repo al n8n de Railway.
 * No requiere n8n local corriendo — lee directamente los archivos.
 *
 * Uso:
 *   node scripts/ops/deploy-warmup-workflows.mjs
 *
 * Variables de entorno requeridas (en .env o en el shell):
 *   N8N_RAILWAY_API_KEY   API key del n8n en Railway
 *   N8N_RAILWAY_URL       URL del n8n en Railway (ej: https://n8n.tudominio.com)
 */

import fs       from 'fs';
import path     from 'path';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

// ─── Cargar .env ──────────────────────────────────────────────────────────────
(function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!(key in process.env)) process.env[key] = val;
  }
})();

// ─── Config ───────────────────────────────────────────────────────────────────
const RAILWAY_URL = (process.env.N8N_RAILWAY_URL || '').replace(/\/$/, '');
const RAILWAY_KEY = process.env.N8N_RAILWAY_API_KEY;

// Orden de deploy: dependencias primero
const WORKFLOWS = [
  { file: 'workflows/WF-ERR-Warmup-Error-Handler.json',   label: 'Error Handler'    },
  { file: 'workflows/WF-010b-Daily-Reset.json',           label: 'Daily Reset'      },
  { file: 'workflows/WF-010a-Process-Single-Line.json',   label: 'Process Line'     },
  { file: 'workflows/WF-010-Warmup-Orchestrator.json',    label: 'Orchestrator'     },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
const c = {
  ok:   s => `\x1b[32m✓\x1b[0m  ${s}`,
  err:  s => `\x1b[31m✗\x1b[0m  ${s}`,
  warn: s => `\x1b[33m⚠\x1b[0m  ${s}`,
  info: s => `\x1b[36mℹ\x1b[0m  ${s}`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
};

async function api(method, endpoint, body = null) {
  const res = await fetch(`${RAILWAY_URL}/api/v1${endpoint}`, {
    method,
    headers: { 'X-N8N-API-KEY': RAILWAY_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = (() => { try { return JSON.parse(text); } catch { return { raw: text }; } })();
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { body: data });
  return data;
}

function clean(wf) {
  // Strips runtime fields that differ between n8n instances
  // tags is read-only in the n8n API — omit from body
  return {
    name:        wf.name,
    nodes:       (wf.nodes || []).map(({ credentials: _, ...n }) => n),
    connections: wf.connections || {},
    settings:    { executionOrder: wf.settings?.executionOrder ?? 'v1' },
  };
}

async function ask(rl, q) {
  if (!process.stdin.isTTY) return true;
  const a = await rl.question(`  ${c.warn('')}${q} [s/N] `);
  return a.trim().toLowerCase() === 's';
}

// ─── Validación ───────────────────────────────────────────────────────────────
function validate() {
  const missing = [];
  if (!RAILWAY_KEY) missing.push('N8N_RAILWAY_API_KEY');
  if (!RAILWAY_URL) missing.push('N8N_RAILWAY_URL');
  if (missing.length) {
    console.error(c.err(`Variables de entorno faltantes: ${missing.join(', ')}`));
    console.error('    Completá el archivo .env con esas variables y volvé a ejecutar.');
    process.exit(1);
  }
  for (const { file } of WORKFLOWS) {
    if (!fs.existsSync(file)) {
      console.error(c.err(`Archivo no encontrado: ${file}`));
      process.exit(1);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n  ${c.bold('Warmup Workflow Deployer — repo JSON → Railway n8n')}`);
  console.log(`  ${c.info(`Destino: ${RAILWAY_URL}`)}\n`);

  validate();

  // Obtener workflows existentes en Railway
  let existing = [];
  try {
    const res = await api('GET', '/workflows?limit=100');
    existing = res.data ?? res;
    console.log(c.info(`${existing.length} workflows en Railway`));
  } catch (err) {
    console.error(c.err(`No se pudo conectar a Railway: ${err.message}`));
    console.error('    Verificá N8N_RAILWAY_URL y N8N_RAILWAY_API_KEY.');
    process.exit(1);
  }

  const byName = Object.fromEntries(existing.map(w => [w.name, w]));
  const rl     = readline.createInterface({ input, output });
  const results = { created: [], updated: [], skipped: [], failed: [] };

  console.log('');

  for (const { file, label } of WORKFLOWS) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const wf  = clean(raw);
    const dup = byName[raw.name];

    console.log(`  ${c.bold(label)} — ${raw.name}`);
    console.log(`    Nodos: ${raw.nodes?.length ?? 0}  |  Archivo: ${file}`);

    if (dup) {
      console.log(c.warn(`    Ya existe en Railway (id: ${dup.id}, activo: ${dup.active})`));
      const ok = await ask(rl, `    ¿Sobreescribir?`);
      if (!ok) {
        console.log(`    ${c.info('Saltado.')}\n`);
        results.skipped.push(raw.name);
        continue;
      }
      try {
        await api('PUT', `/workflows/${dup.id}`, wf);
        console.log(c.ok(`    Actualizado (id: ${dup.id})\n`));
        results.updated.push(raw.name);
      } catch (err) {
        console.error(c.err(`    Error al actualizar: ${err.message}`));
        if (err.body?.message) console.error(`    Detalle: ${err.body.message}`);
        results.failed.push(raw.name);
        console.log('');
      }
    } else {
      try {
        const created = await api('POST', '/workflows', wf);
        console.log(c.ok(`    Creado (id: ${created.id})\n`));
        results.created.push(raw.name);
      } catch (err) {
        console.error(c.err(`    Error al crear: ${err.message}`));
        if (err.body?.message) console.error(`    Detalle: ${err.body.message}`);
        results.failed.push(raw.name);
        console.log('');
      }
    }
  }

  rl.close();

  // ─── Resumen ─────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(56)}`);
  console.log(`  ${c.bold('Resumen del deploy')}`);
  console.log(`${'─'.repeat(56)}`);
  if (results.created.length)  console.log(c.ok( `Creados  (${results.created.length}): ${results.created.join(', ')}`));
  if (results.updated.length)  console.log(c.ok( `Actualizados (${results.updated.length}): ${results.updated.join(', ')}`));
  if (results.skipped.length)  console.log(c.warn(`Saltados (${results.skipped.length}): ${results.skipped.join(', ')}`));
  if (results.failed.length)   console.log(c.err( `Fallidos (${results.failed.length}): ${results.failed.join(', ')}`));

  if (results.failed.length) {
    console.log('');
    process.exit(1);
  }

  if (results.created.length + results.updated.length > 0) {
    console.log(`
${'─'.repeat(56)}
  ${c.bold('Próximos pasos en Railway n8n:')}

  1. Abrí cada workflow nuevo y linkeá las credenciales:
       • "Supabase Service"  → credencial con apikey header de Supabase
       • "Evolution API"     → credencial con api-key header de Evolution

  2. En WF-010a, Settings → Error Workflow → seleccionar
     "WF-ERR-Warmup-Error-Handler"

  3. Desactivá el workflow anterior:
     "WF-010-Line-Warmup"  (el monolítico de 14 nodos)

  4. Activá en este orden:
       WF-ERR-Warmup-Error-Handler   ← primero
       WF-010b-Daily-Reset
       WF-010a-Process-Single-Line
       WF-010-Warmup-Orchestrator    ← último
${'─'.repeat(56)}`);
  }
}

main().catch(err => {
  console.error(c.err(`Error inesperado: ${err.message}`));
  process.exit(1);
});
