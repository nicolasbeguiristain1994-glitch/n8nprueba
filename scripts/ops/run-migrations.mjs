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
const YES_PROD   = process.argv.includes('--yes-i-know-this-is-production');
const FILE_FILTER = (() => {
  const idx = process.argv.indexOf('--file');
  return idx >= 0 ? process.argv[idx + 1] : null;
})();

// Accept both naming conventions; no silent fallback for required fields
const DB_CONFIG = {
  host:     process.env.DB_POSTGRESDB_HOST     || process.env.DB_HOST,
  port:     parseInt(process.env.DB_POSTGRESDB_PORT || process.env.DB_PORT || '5432'),
  database: process.env.DB_POSTGRESDB_DATABASE  || process.env.DB_NAME,
  user:     process.env.DB_POSTGRESDB_USER      || process.env.DB_USER,
  password: process.env.DB_POSTGRESDB_PASSWORD  || process.env.DB_PASSWORD || '',
  ssl:      (() => {
    const sslVal = process.env.DB_POSTGRESDB_SSL ?? process.env.DB_SSL;
    if (sslVal === 'false') return false;
    if (sslVal === 'true')  return { rejectUnauthorized: false };
    // No explicit setting: default SSL off for localhost, on for remote hosts
    const host = process.env.DB_POSTGRESDB_HOST || process.env.DB_HOST || '';
    if (sslVal === undefined && (host === 'localhost' || host === '127.0.0.1' || host === '')) return false;
    return { rejectUnauthorized: false };
  })(),
};

// Orden de ejecución de migraciones
const MIGRATIONS = [
  { file: 'db/schema/init.sql',                                    label: '000 — Schema inicial (tablas base)' },
  { file: 'db/migrations/001_whatsapp_lines.sql',                  label: '001 — whatsapp_lines + line_metrics' },
  { file: 'db/migrations/002_sequence_engine.sql',                 label: '002 — Sequence Engine functions' },
  { file: 'db/migrations/003_import_and_inactivity.sql',           label: '003 — Import logs + inactivity' },
  { file: 'db/migrations/004_human_handoff.sql',                   label: '004 — Human handoff + conversation_state' },
  { file: 'db/migrations/005_campaign_personalize_name.sql',       label: '005 — Campaign personalize_name flag' },
  { file: 'db/migrations/006_contacts_linea.sql',                  label: '006 — Contacts linea (1-12)' },
  { file: 'db/migrations/007_evolution_id_unique.sql',             label: '007 — Evolution message ID unique index' },
  { file: 'db/migrations/008_campaign_recipients.sql',             label: '008 — Campaign recipients table' },
  { file: 'db/migrations/008b_contacts_panel_gaming.sql',          label: '008b — contacts panel/gaming columns + enum' },
  { file: 'db/migrations/008c_contact_lists.sql',                  label: '008c — contact_lists + contact_list_members tables' },
  { file: 'db/migrations/009_performance_indexes.sql',             label: '009 — Performance indexes' },
  { file: 'db/migrations/010_message_status_received.sql',         label: '010 — message_status: received value' },
  { file: 'db/migrations/011_contacts_phone_unique.sql',           label: '011 — contacts.phone_number unique constraint' },
  { file: 'db/migrations/012_whatsapp_lines_evolution_unique.sql', label: '012 — whatsapp_lines evolution_instance unique' },
  { file: 'db/migrations/013_campaign_recipients_durability.sql',  label: '013 — campaign_recipients durability index' },
  { file: 'db/migrations/014_campaign_durability_idempotency.sql', label: '014 — campaign durability + idempotency' },
  { file: 'db/migrations/015_campaign_processor_lock_token.sql',  label: '015 — campaign processor lock token' },
  { file: 'db/migrations/016_users_rbac.sql',                     label: '016 — Users table + RBAC roles' },
  { file: 'db/migrations/017_audit_logging.sql',                  label: '017 — RBAC audit log table' },
  { file: 'db/migrations/018_campaign_ownership.sql',             label: '018 — Campaign ownership (owned_by / updated_by)' },
  { file: 'db/migrations/019_campaign_updated_by_fix.sql',        label: '019 — Fix campaigns.updated_by: varchar→uuid + FK' },
  { file: 'db/migrations/020_contact_lists_ownership.sql',        label: '020 — Contact list ownership (owned_by / updated_by)' },
  { file: 'db/migrations/021_campaigns_schema_alignment.sql',    label: '021 — Campaigns schema alignment with current routes' },
  { file: 'db/migrations/022_tickets.sql',                       label: '022 — Tickets module (tickets, ticket_notes, ticket_events)' },
  { file: 'db/migrations/023_campaign_multiline.sql',            label: '023 — Multi-line campaign distributor (line_id, use_multi_line, sending_enabled, line_usage_log)' },
  { file: 'db/migrations/024_proxies_and_assignment.sql',        label: '024 — Proxy registry + line-proxy assignment' },
  { file: 'db/migrations/025_casino_players.sql',                label: '025 — casino_players segmentation table' },
  { file: 'db/migrations/026_contact_segment_casino.sql',        label: '026 — contact_segment enum: bajo/medio/alto casino values' },
  { file: 'db/migrations/027_casino_actividad_perdido.sql',      label: '027 — casino_players seg_actividad: add perdido value' },
  { file: 'db/migrations/028_casino_transactions.sql',           label: '028 — casino_transactions table (individual transactions by date)' },
  { file: 'db/migrations/029_casino_player_labels.sql',          label: '029 — casino_players.labels TEXT[] column (operator tags)' },
  { file: 'db/migrations/030_cleanup_ghost_agent_players.sql',   label: '030 — delete ghost agent-as-player rows from casino_players + casino_transactions' },
  { file: 'db/migrations/031_casino_transactions_timestamp.sql', label: '031 — casino_transactions.fecha_hora_utc TIMESTAMPTZ for sub-day filtering' },
  { file: 'db/migrations/032_enable_rls.sql',                   label: '032 — Enable RLS on all public tables (blocks anon key access)' },
  { file: 'db/migrations/033_delete_test_contacts.sql',         label: '033 — Delete test contacts' },
  { file: 'db/migrations/034_contact_lists_source.sql',         label: '034 — contact_lists.source column' },
  { file: 'db/migrations/035_operator_contact_visibility.sql',  label: '035 — Operator contact visibility rules' },
  { file: 'db/migrations/036_users_permissions.sql',            label: '036 — Users granular permissions' },
  { file: 'db/migrations/037_contacts_linea_100.sql',           label: '037 — contacts.linea up to 100 lines' },
  { file: 'db/migrations/038_app_settings.sql',                 label: '038 — app_settings table' },
  { file: 'db/migrations/039_whatsapp_templates.sql',           label: '039 — WhatsApp message templates' },
  { file: 'db/migrations/040_campaigns_template.sql',           label: '040 — Campaigns template_id FK' },
  { file: 'db/migrations/041_blacklist.sql',                    label: '041 — Global blacklist table' },
  { file: 'db/migrations/042_automations.sql',                  label: '042 — Automations / bots module' },
  { file: 'db/migrations/043_whatsapp_lines_personality.sql',   label: '043 — whatsapp_lines personality columns' },
  { file: 'db/migrations/044_warmup_display_name.sql',          label: '044 — Warmup display_name column' },
  { file: 'db/migrations/045_tasks.sql',                        label: '045 — Tasks module (tasks, task_assignees, task_logs)' },
  { file: 'db/migrations/046_tasks_soft_delete.sql',            label: '046 — Tasks soft delete (deleted_at, deleted_by)' },
  { file: 'db/migrations/047_tasks_description_trgm.sql',       label: '047 — Tasks trigram indexes (title + description)' },
  { file: 'db/migrations/048_notifications.sql',                label: '048 — Notifications module (notifications + preferences)' },
  { file: 'db/migrations/049_create_deals.sql',                label: '049 — Deals module' },
  { file: 'db/migrations/050_contact_frequency_engine.sql',    label: '050 — ContactFrequencyEngine (contact_frequency_rules + contact_send_history)' },
  { file: 'db/migrations/051_contact_frequency_removed_by.sql', label: '051 — contact_frequency_rules.removed_by column' },
  { file: 'db/migrations/052_whatsapp_lines_delete_cascade.sql', label: '052 — whatsapp_lines FK: campaign_recipients SET NULL, line_usage_log CASCADE' },
  { file: 'db/migrations/053_relax_line_key_constraint.sql',     label: '053 — Relax line_key CHECK constraint format' },
  { file: 'db/migrations/054_campaigns_pause_reason.sql',          label: '054 — campaigns.pause_reason column' },
  { file: 'db/migrations/055_campaigns_pause_reason_extended.sql', label: '055 — pause_reason CHECK: add all_lines_outside_schedule' },
  { file: 'db/migrations/056_conversation_notes.sql',              label: '056 — conversation_notes table (notas internas por conversación)' },
  { file: 'db/migrations/057_warmup_delay_preset.sql',             label: '057 — warmup_numbers.delay_preset column' },
  { file: 'db/migrations/058_warmup_anti_ban.sql',                 label: '058 — warmup_numbers anti-ban columns (8 campos)' },
  { file: 'db/migrations/059_warmup_missing_columns.sql',          label: '059 — warmup_numbers display_name + evolution_url (fix 044)' },
  { file: 'db/migrations/066_fixed_line_and_transactions.sql',     label: '066 — phone_line_assignments + contacts transaction fields' },
  { file: 'db/migrations/067_cloud_api_numbers.sql',               label: '067 — cloud_api_numbers table' },
  { file: 'db/migrations/068_cloud_api_conversations.sql',          label: '068 — cloud_api_conversations table' },
  { file: 'db/migrations/069_cloud_api_opt_outs.sql',              label: '069 — cloud_api_opt_outs table' },
  { file: 'db/migrations/070_encrypt_tokens.sql',                   label: '070 — encrypt_tokens helpers' },
  { file: 'db/migrations/071_anti_ban_profiles.sql',                label: '071 — anti_ban_profiles table + warmup_numbers.anti_ban_profile_id' },
  { file: 'db/migrations/072_campaigns_anti_ban.sql',               label: '072 — anti-ban fields en campaigns' },
  { file: 'db/migrations/073_line_ownership.sql',                   label: '073 — line_ownership table' },
  { file: 'db/migrations/074_add_indexes_casino_performance.sql',   label: '074 — índices de performance casino' },
  { file: 'db/migrations/075_contacts_platforms.sql',               label: '075 — contacts.platforms column + trigger + GIN index' },
  { file: 'db/migrations/076_contacts_platforms_bet30_regex_only.sql', label: '076 — Fix bet30 detection: regex-only (no casino_players lookup)' },
  { file: 'db/migrations/077_contacts_platforms_zeus_fix.sql',          label: '077 — Fix Zeus detection: add ze suffix + casino_players token match' },
  { file: 'db/migrations/078_campaigns_total_skipped.sql',              label: '078 — campaigns.total_skipped column' },
  { file: 'db/migrations/079_contact_priority_scores.sql',              label: '079 — contact_priority_scores table + indexes' },
  { file: 'db/migrations/080_contacts_deposit_amounts.sql',             label: '080 — contacts.total_deposit_amount + last_deposit_amount' },
  { file: 'db/migrations/082_system_jobs.sql',                          label: '082 — system_jobs locking table' },
  { file: 'db/migrations/083_cps_add_fria_alto_valor_segment.sql',      label: '083 — reactivation_segment CHECK: add FRIA_ALTO_VALOR' },
  { file: 'db/migrations/084_system_jobs_lock_token.sql',               label: '084 — system_jobs.lock_token column' },
  { file: 'db/migrations/085_cps_operator_indexes.sql',                 label: '085 — CPS operator indexes (tier, days_inactive, platforms GIN)' },
  { file: 'db/migrations/086_cps_run_id.sql',                           label: '086 — contact_priority_scores.run_id + system_jobs.last_complete_run_id' },
  { file: 'db/migrations/087_recompute_runs.sql',                       label: '087 — recompute_runs history table' },
  { file: 'db/migrations/088_cps_broadcasted.sql',                      label: '088 — contact_priority_scores.is_broadcasted + broadcasted_at' },
  { file: 'db/migrations/089_line_type_cloud.sql',                      label: '089 — whatsapp_lines.line_type (evolution | cloud)' },
  { file: 'db/migrations/090_cloud_chatwoot_inbox.sql',                 label: '090 — cloud_numbers campos chatwoot_inbox_*' },
  { file: 'db/migrations/091_prospects.sql',                            label: '091 — Base de Difusión: prospects + prospect_import_batches + prospect_id en campaign_recipients' },
  { file: 'db/migrations/092_whatsapp_lines_cloud_schema.sql',          label: '092 — whatsapp_lines: line_key VARCHAR(50), evolution_instance/url nullable para líneas cloud' },
  { file: 'db/migrations/093_campaigns_message_type.sql',               label: '093 — campaigns.message_type (text | template)' },
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
  // Fail fast if required connection fields are missing
  const missing = [];
  if (!DB_CONFIG.host)     missing.push('DB_POSTGRESDB_HOST or DB_HOST');
  if (!DB_CONFIG.database) missing.push('DB_POSTGRESDB_DATABASE or DB_NAME');
  if (!DB_CONFIG.user)     missing.push('DB_POSTGRESDB_USER or DB_USER');
  if (!DB_CONFIG.password || DB_CONFIG.password === 'TU_PASSWORD_AQUI' || DB_CONFIG.password === 'replace-me') {
    missing.push('DB_POSTGRESDB_PASSWORD or DB_PASSWORD');
  }
  if (missing.length) {
    log.error('Faltan variables de entorno requeridas:');
    for (const m of missing) log.error(`  · ${m}`);
    log.error('Editá el archivo .env y completá los valores.');
    process.exit(1);
  }

  // Production guard: require explicit opt-in flag
  const isProd = (
    process.env.NODE_ENV === 'production' ||
    process.env.DOPPLER_CONFIG === 'prd' ||
    (DB_CONFIG.host.includes('supabase.com') && !DB_CONFIG.host.includes('localhost'))
  );
  if (isProd && !YES_PROD && !DRY_RUN) {
    log.error('');
    log.error('  PRODUCTION DATABASE DETECTED');
    log.error(`  Host: ${DB_CONFIG.host}`);
    log.error('');
    log.error('  To run migrations against production, add the flag:');
    log.error('    --yes-i-know-this-is-production');
    log.error('');
    log.error('  Example:');
    log.error('    node scripts/ops/run-migrations.mjs --yes-i-know-this-is-production');
    log.error('');
    process.exit(1);
  }
  if (isProd) {
    log.warn('  *** PRODUCTION DATABASE — proceeding because --yes-i-know-this-is-production was passed ***');
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
