#!/usr/bin/env node
/**
 * run-migrations.mjs
 * Ejecuta las migraciones SQL en orden contra la base de datos configurada.
 *
 * Uso:
 *   node scripts/ops/run-migrations.mjs
 *   node scripts/ops/run-migrations.mjs --dry-run   (muestra qué ejecutaría)
 *   node scripts/ops/run-migrations.mjs --file 002  (solo una migración)
 *
 * Requiere:
 *   npm install pg              (driver de PostgreSQL)
 *
 * Variables de entorno (.env):
 *   DB_POSTGRESDB_HOST
 *   DB_POSTGRESDB_DATABASE
 *   DB_POSTGRESDB_USER
 *   DB_POSTGRESDB_PASSWORD
 *   DB_POSTGRESDB_PORT         (opcional, default 5432)
 *   DB_POSTGRESDB_SSL          (opcional, default 'true')
 */

import fs   from 'fs';
import path from 'path';

// ─── Carga de .env ────────────────────────────────────────────────────────────

(function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    console.warn('  ⚠  .env no encontrado — usando variables del shell.');
    return;
  }
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key   = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!(key in process.env)) process.env[key] = value;
  }
})();

// ─── Verificar que pg está instalado ─────────────────────────────────────────

let pg;
try {
  pg = (await import('pg')).default;
} catch {
  console.error('\n  ✗ El paquete "pg" no está instalado.');
  console.error('    Ejecutá: npm install pg\n');
  process.exit(1);
}

const { Client } = pg;

// ─── Config ───────────────────────────────────────────────────────────────────

const DRY_RUN    = process.argv.includes('--dry-run');
const FILE_FILTER = (() => {
  const idx = process.argv.indexOf('--file');
  return idx >= 0 ? process.argv[idx + 1] : null;
})();

const DB_CONFIG = {
  host:     process.env.DB_POSTGRESDB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_POSTGRESDB_PORT || '5432'),
  database: process.env.DB_POSTGRESDB_DATABASE  || 'postgres',
  user:     process.env.DB_POSTGRESDB_USER      || 'postgres',
  password: process.env.DB_POSTGRESDB_PASSWORD  || '',
  ssl:      (process.env.DB_POSTGRESDB_SSL ?? 'true') === 'true'
            ? { rejectUnauthorized: false }
            : false,
};

// Orden de ejecución de migraciones
const MIGRATIONS = [
  { file: 'db/schema/init.sql',                 label: '000 — Schema inicial (tablas base)' },
  { file: 'db/migrations/001_whatsapp_lines.sql', label: '001 — whatsapp_lines + line_metrics' },
  { file: 'db/migrations/002_sequence_engine.sql', label: '002 — Sequence Engine functions' },
  { file: 'db/migrations/003_import_and_inactivity.sql', label: '003 — Import logs + inactivity' },
  { file: 'db/migrations/004_human_handoff.sql', label: '004 — Human handoff + conversation_state' },
  { file: 'db/migrations/005_campaign_personalize_name.sql', label: '005 — Campaign personalize_name flag' },
  { file: 'db/migrations/006_contacts_linea.sql', label: '006 — Contacts linea (1-12)' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const log = {
  section: (msg) => console.log(`\n${'═'.repeat(60)}\n  ${msg}\n${'═'.repeat(60)}`),
  ok:      (msg) => console.log(`  ✓  ${msg}`),
  info:    (msg) => console.log(`  ℹ  ${msg}`),
  warn:    (msg) => console.log(`  ⚠  ${msg}`),
  error:   (msg) => console.error(`  ✗  ${msg}`),
  step:    (msg) => console.log(`\n  ▶  ${msg}`),
};

// ─── Verificaciones ───────────────────────────────────────────────────────────

function validate() {
  if (!DB_CONFIG.password || DB_CONFIG.password === 'TU_PASSWORD_AQUI') {
    log.error('DB_POSTGRESDB_PASSWORD no está configurada en .env');
    log.error('Editá el archivo .env y completá la contraseña de Supabase.');
    process.exit(1);
  }
}

// ─── Crear tabla de tracking de migraciones ───────────────────────────────────

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          SERIAL PRIMARY KEY,
      filename    VARCHAR(255) NOT NULL UNIQUE,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      duration_ms INT,
      checksum    VARCHAR(64)
    );
  `);
}

async function getMigrationsApplied(client) {
  const res = await client.query('SELECT filename FROM _migrations ORDER BY id;');
  return new Set(res.rows.map(r => r.filename));
}

async function markMigrationApplied(client, filename, durationMs) {
  await client.query(
    'INSERT INTO _migrations (filename, duration_ms) VALUES ($1, $2) ON CONFLICT (filename) DO NOTHING;',
    [filename, durationMs]
  );
}

// ─── Ejecutar una migración ───────────────────────────────────────────────────

async function runMigration(client, migration) {
  const filePath = path.resolve(process.cwd(), migration.file);

  if (!fs.existsSync(filePath)) {
    log.warn(`Archivo no encontrado, saltando: ${migration.file}`);
    return { status: 'skipped', reason: 'FILE_NOT_FOUND' };
  }

  const sql = fs.readFileSync(filePath, 'utf8');
  const lineCount = sql.split('\n').length;

  log.step(`${migration.label}`);
  log.info(`Archivo: ${migration.file} (${lineCount} líneas)`);

  if (DRY_RUN) {
    log.warn('DRY RUN — no ejecutado');
    return { status: 'dry_run' };
  }

  const start = Date.now();
  try {
    await client.query(sql);
    const ms = Date.now() - start;
    log.ok(`Ejecutada en ${ms}ms`);
    await markMigrationApplied(client, migration.file, ms);
    return { status: 'ok', ms };
  } catch (err) {
    log.error(`Error en ${migration.file}:`);
    // Mostrar solo las primeras líneas del error para no saturar
    const msg = err.message?.split('\n').slice(0, 5).join('\n    ');
    log.error(`    ${msg}`);
    return { status: 'error', error: err };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log.section('WhatsApp Platform — DB Migrations');

  if (DRY_RUN) log.warn('Modo DRY RUN activado — no se ejecutará nada en la DB');
  if (FILE_FILTER) log.info(`Filtro activo: solo archivos que contengan "${FILE_FILTER}"`);

  validate();

  log.info(`Host:     ${DB_CONFIG.host}`);
  log.info(`Database: ${DB_CONFIG.database}`);
  log.info(`User:     ${DB_CONFIG.user}`);
  log.info(`SSL:      ${DB_CONFIG.ssl ? 'enabled' : 'disabled'}`);

  const client = new Client(DB_CONFIG);

  try {
    log.step('Conectando a la base de datos...');
    await client.connect();
    log.ok('Conexión establecida');

    if (!DRY_RUN) {
      await ensureMigrationsTable(client);
    }

    const applied = DRY_RUN ? new Set() : await getMigrationsApplied(client);
    if (applied.size > 0) {
      log.info(`Migraciones ya aplicadas: ${[...applied].map(f => path.basename(f)).join(', ')}`);
    }

    // Filtrar migraciones a ejecutar
    const toRun = MIGRATIONS.filter(m => {
      if (FILE_FILTER && !m.file.includes(FILE_FILTER)) return false;
      if (applied.has(m.file)) {
        log.info(`  ↩  Ya aplicada, saltando: ${m.label}`);
        return false;
      }
      return true;
    });

    if (toRun.length === 0) {
      log.section('No hay migraciones pendientes — base de datos actualizada');
      return;
    }

    log.info(`\n  Migraciones a ejecutar: ${toRun.length}`);

    const results = { ok: 0, skipped: 0, error: 0, dry_run: 0 };

    for (const migration of toRun) {
      const result = await runMigration(client, migration);
      results[result.status] = (results[result.status] || 0) + 1;

      // Si una migración falla, preguntar si continuar
      if (result.status === 'error') {
        log.error('Migración fallida. Abortando para evitar estado inconsistente.');
        break;
      }
    }

    log.section('Resultado Final');
    log.info(`  ✓ Exitosas:  ${results.ok}`);
    if (results.skipped) log.info(`  ↩ Saltadas:  ${results.skipped}`);
    if (results.dry_run) log.info(`  ⚠ Dry run:   ${results.dry_run}`);
    if (results.error)   log.error(`  ✗ Con error: ${results.error}`);

    if (!results.error && !DRY_RUN) {
      log.ok('\n  Base de datos actualizada correctamente.');
      log.info('  Próximo paso: importar los workflows en n8n.');
      log.info('  Ver: docs/runbooks/import-workflows-n8n.md');
    }

  } catch (err) {
    log.error(`Error de conexión: ${err.message}`);
    if (err.code === 'ECONNREFUSED') {
      log.error('No se puede conectar a la DB. Verificar host y puerto en .env');
    } else if (err.code === '28P01') {
      log.error('Contraseña incorrecta. Verificar DB_POSTGRESDB_PASSWORD en .env');
    } else if (err.code === '3D000') {
      log.error('Base de datos no encontrada. Verificar DB_POSTGRESDB_DATABASE en .env');
    }
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('\n  ✗ Error inesperado:', err.message);
  process.exit(1);
});
