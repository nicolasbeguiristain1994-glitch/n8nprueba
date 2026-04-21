#!/usr/bin/env node
/**
 * create-admin-user.mjs
 * Creates or updates an admin user in the users table.
 *
 * Usage:
 *   node scripts/ops/create-admin-user.mjs
 *
 * Required env vars (or in .env):
 *   ADMIN_EMAIL      — email for the admin user
 *   ADMIN_PASSWORD   — password (min 10 chars)
 *   ADMIN_NAME       — display name (optional, defaults to "Admin")
 *
 * DB connection uses same dual env resolution as run-migrations.mjs:
 *   DB_POSTGRESDB_HOST / DB_HOST
 *   DB_POSTGRESDB_DATABASE / DB_NAME
 *   DB_POSTGRESDB_USER / DB_USER
 *   DB_POSTGRESDB_PASSWORD / DB_PASSWORD
 *   DB_POSTGRESDB_PORT / DB_PORT
 *   DB_POSTGRESDB_SSL / DB_SSL
 */

import fs   from 'fs';
import path from 'path';

// ─── Load .env ────────────────────────────────────────────────────────────────

(function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    console.warn('  ⚠  .env not found — using shell variables.');
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

// ─── Verify pg is installed ───────────────────────────────────────────────────

let pg;
try {
  pg = (await import('pg')).default;
} catch {
  console.error('\n  ✗ The "pg" package is not installed.');
  console.error('    Run: npm install pg\n');
  process.exit(1);
}

// ─── Verify bcryptjs is installed ────────────────────────────────────────────

let bcryptjs;
try {
  bcryptjs = (await import('bcryptjs')).default;
} catch {
  console.error('\n  ✗ The "bcryptjs" package is not installed.');
  console.error('    Run: cd frontend && npm install bcryptjs\n');
  process.exit(1);
}

const { Client } = pg;

// ─── DB Config (dual env resolution) ─────────────────────────────────────────

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
    const host = process.env.DB_POSTGRESDB_HOST || process.env.DB_HOST || '';
    if (sslVal === undefined && (host === 'localhost' || host === '127.0.0.1' || host === '')) return false;
    return { rejectUnauthorized: false };
  })(),
};

// ─── Production guard ─────────────────────────────────────────────────────────

const YES_PROD = process.argv.includes('--yes-i-know-this-is-production');

const isProd = (
  process.env.NODE_ENV === 'production' ||
  process.env.DOPPLER_CONFIG === 'prd' ||
  ((DB_CONFIG.host || '').includes('supabase.com') && !(DB_CONFIG.host || '').includes('localhost'))
);

if (isProd && !YES_PROD) {
  console.error('\n  ✗  PRODUCTION DATABASE DETECTED');
  console.error(`     Host: ${DB_CONFIG.host}`);
  console.error('');
  console.error('     To run against production, add the flag:');
  console.error('       --yes-i-know-this-is-production');
  console.error('');
  process.exit(1);
}

if (isProd) {
  console.warn('\n  ⚠  *** PRODUCTION DATABASE — proceeding because --yes-i-know-this-is-production was passed ***\n');
}

// ─── Validate required env vars ───────────────────────────────────────────────

const ADMIN_EMAIL    = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_NAME     = process.env.ADMIN_NAME || 'Admin';

const errors = [];
if (!ADMIN_EMAIL)    errors.push('ADMIN_EMAIL is required');
if (!ADMIN_PASSWORD) errors.push('ADMIN_PASSWORD is required');
if (ADMIN_PASSWORD && ADMIN_PASSWORD.length < 10) {
  errors.push('ADMIN_PASSWORD must be at least 10 characters');
}
if (!DB_CONFIG.host)     errors.push('DB_POSTGRESDB_HOST or DB_HOST is required');
if (!DB_CONFIG.database) errors.push('DB_POSTGRESDB_DATABASE or DB_NAME is required');
if (!DB_CONFIG.user)     errors.push('DB_POSTGRESDB_USER or DB_USER is required');
if (!DB_CONFIG.password || DB_CONFIG.password === 'TU_PASSWORD_AQUI' || DB_CONFIG.password === 'replace-me') {
  errors.push('DB_POSTGRESDB_PASSWORD or DB_PASSWORD is required');
}

if (errors.length) {
  console.error('\n  ✗ Missing or invalid configuration:');
  for (const e of errors) console.error(`    · ${e}`);
  console.error('');
  process.exit(1);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  WhatsApp Platform — Create Admin User');
  console.log('══════════════════════════════════════════════════════════════\n');

  console.log(`  Email: ${ADMIN_EMAIL}`);
  console.log(`  Name:  ${ADMIN_NAME}`);
  console.log(`  Role:  admin`);
  console.log(`  Host:  ${DB_CONFIG.host}`);
  console.log('');

  // Hash password with bcryptjs (rounds=12)
  console.log('  Hashing password (bcrypt rounds=12)...');
  const passwordHash = await bcryptjs.hash(ADMIN_PASSWORD, 12);
  console.log('  ✓ Password hashed\n');

  const client = new Client(DB_CONFIG);

  try {
    console.log('  Connecting to database...');
    await client.connect();
    console.log('  ✓ Connected\n');

    // Upsert: on conflict (lower email) update password, name, role, is_active, updated_at
    const sql = `
      INSERT INTO users (email, password_hash, name, role, sectors, is_active)
      VALUES ($1, $2, $3, 'admin', '[]'::jsonb, true)
      ON CONFLICT (LOWER(email)) DO UPDATE
        SET password_hash    = EXCLUDED.password_hash,
            name             = EXCLUDED.name,
            role             = 'admin',
            is_active        = true,
            session_version  = users.session_version + 1,
            updated_at       = NOW()
      RETURNING id, email, name, role, is_active, created_at;
    `;

    const result = await client.query(sql, [
      ADMIN_EMAIL.toLowerCase().trim(),
      passwordHash,
      ADMIN_NAME,
    ]);

    const user = result.rows[0];
    console.log('  ✓ Admin user upserted successfully\n');
    console.log('  User details:');
    console.log(`    ID:         ${user.id}`);
    console.log(`    Email:      ${user.email}`);
    console.log(`    Name:       ${user.name}`);
    console.log(`    Role:       ${user.role}`);
    console.log(`    Active:     ${user.is_active}`);
    console.log(`    Created at: ${user.created_at}`);
    console.log('');
    console.log('  ✓ Done. You can now log in with the admin credentials.\n');

  } catch (err) {
    console.error(`  ✗ Error: ${err.message}`);
    if (err.code === 'ECONNREFUSED') {
      console.error('    Cannot connect to DB. Check host and port in .env');
    } else if (err.code === '28P01') {
      console.error('    Wrong password. Check DB_POSTGRESDB_PASSWORD in .env');
    } else if (err.code === '3D000') {
      console.error('    Database not found. Check DB_POSTGRESDB_DATABASE in .env');
    } else if (err.code === '42P01') {
      console.error('    Table "users" does not exist. Run migration 016 first:');
      console.error('      node scripts/ops/run-migrations.mjs --file 016');
    }
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('\n  ✗ Unexpected error:', err.message);
  process.exit(1);
});
