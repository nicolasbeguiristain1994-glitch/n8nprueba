#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const SCHEMAS = ['public', 'app_migrations'];
const q = name => '"' + name.replaceAll('"', '""') + '"';
const qualified = t => `${q(t.schema)}.${q(t.name)}`;
const tool = name => path.join(process.env.PG_BIN ?? '', name);
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', {mode: 0o600, flag: 'wx'});

export function connection(urlString, localOnly = false) {
  const url = new URL(urlString);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash) throw Error('Use a PostgreSQL URL without query parameters');
  if (localOnly && !local) throw Error('Restore drills are restricted to localhost');
  if (!url.pathname.slice(1)) throw Error('Database name required');
  return {url, local};
}
function clientFor(urlString, localOnly = false) {
  const {url, local} = connection(urlString, localOnly);
  const ca = !local && process.env.PGSSLROOTCERT && process.env.PGSSLROOTCERT !== 'system'
    ? fs.readFileSync(process.env.PGSSLROOTCERT, 'utf8') : undefined;
  return new pg.Client({connectionString: url.toString(), connectionTimeoutMillis: 15000,
    ssl: local ? false : {rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false', ...(ca ? {ca} : {})},
    application_name: 'verified-database-backup'});
}
function pgEnv(urlString) {
  const {url, local} = connection(urlString);
  const env = {...process.env, PGHOST: url.hostname.replace(/^\[|\]$/g, ''), PGPORT: url.port || '5432', PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: local ? 'disable' : (process.env.DB_SSL_REJECT_UNAUTHORIZED === 'false' ? 'require' : 'verify-full'),
    PGCONNECT_TIMEOUT: '15', PGOPTIONS: '-c timezone=UTC -c extra_float_digits=3'};
  // A libpq service or hostaddr inherited from the shell must not redirect a
  // localhost restore to another server.
  for (const key of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE']) delete env[key];
  return env;
}
async function command(name, args, env, log) {
  const fd = fs.openSync(log, 'a', 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(tool(name), args, {env, stdio: ['ignore', fd, fd]});
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(Error(`${name} failed (${code}); inspect the private log ${log}`)));
    });
  } finally { fs.closeSync(fd); }
}
export async function fileSha(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function inventory(client) {
  return (await client.query(`SELECT n.nspname AS schema,c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p') ORDER BY 1,2`, [SCHEMAS])).rows;
}
async function fingerprints(client, tables) {
  const result = [];
  for (const t of tables) {
    const {rows: [row]} = await client.query(`SELECT count(*)::text AS rows,
      COALESCE(sum(hashtextextended(row_to_json(t)::text,0)::numeric),0)::text AS checksum FROM ${qualified(t)} t`);
    result.push({...t, ...row});
  }
  return result;
}
export function compareTables(expected, actual) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw Error('Restored table inventory, row counts or data checksums differ from the source snapshot');
}
export async function createBackup(urlString, directory) {
  connection(urlString);
  fs.mkdirSync(path.dirname(directory), {recursive: true, mode: 0o700});
  fs.mkdirSync(directory, {mode: 0o700}); // Never reuse/overwrite an existing backup.
  const client = clientFor(urlString);
  const startedAt = new Date().toISOString();
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='10min'; SET LOCAL idle_in_transaction_session_timeout='20min'; SET LOCAL timezone='UTC'; SET LOCAL extra_float_digits=3");
    const {rows: [state]} = await client.query("SELECT pg_export_snapshot() AS snapshot,current_setting('server_version_num') AS version");
    const tables = await inventory(client);
    if (!tables.some(t => t.name === 'contacts') || !tables.some(t => t.schema === 'app_migrations')) throw Error('Expected application tables and migration ledger are missing');
    const extensions = (await client.query(`SELECT e.extname AS name,n.nspname AS schema FROM pg_extension e
      JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname NOT IN ('plpgsql','supabase_vault') ORDER BY 1`)).rows;
    const roles = (await client.query('SELECT DISTINCT unnest(roles)::text AS name FROM pg_policies WHERE schemaname=ANY($1::text[]) ORDER BY 1', [SCHEMAS])).rows.map(r => r.name).filter(r => r !== 'public');
    const dump = path.join(directory, 'application.dump');
    await command('pg_dump', ['--format=custom','--compress=6','--no-owner','--no-acl','--lock-wait-timeout=10s',
      ...SCHEMAS.flatMap(s => ['--schema', s]), `--snapshot=${state.snapshot}`, '--file', dump],
      {...pgEnv(urlString), PGOPTIONS: '-c default_transaction_read_only=on -c timezone=UTC -c extra_float_digits=3'}, path.join(directory, 'backup.log'));
    fs.chmodSync(dump, 0o600);
    const data = await fingerprints(client, tables);
    await client.query('COMMIT');
    const manifest = {format: 1, startedAt, completedAt: new Date().toISOString(), postgresMajor: Math.floor(Number(state.version) / 10000),
      schemas: SCHEMAS, excluded: ['Supabase-managed schemas (auth, storage, realtime, vault)', 'Storage object files', 'Provider settings and credentials'],
      extensions, roles, tables: data, archive: {file: 'application.dump', sha256: await fileSha(dump), bytes: fs.statSync(dump).size}};
    writeJson(path.join(directory, 'manifest.json'), manifest);
    return {directory, tables: data.length, rows: data.reduce((n,t) => n + BigInt(t.rows), 0n).toString(), bytes: manifest.archive.bytes, sha256: manifest.archive.sha256};
  } finally { await client.end(); }
}
export async function restoreDrill(localAdminUrl, directory) {
  const {url} = connection(localAdminUrl, true);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.format !== 1 || JSON.stringify(manifest.schemas) !== JSON.stringify(SCHEMAS) || manifest.archive.file !== 'application.dump') throw Error('Unsupported backup manifest');
  const dump = path.join(directory, 'application.dump');
  if (await fileSha(dump) !== manifest.archive.sha256) throw Error('Backup archive checksum mismatch');
  const admin = clientFor(url.toString(), true);
  await admin.connect();
  const database = `restore_probe_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const started = Date.now();
  let restored;
  try {
    const {rows: [version]} = await admin.query("SELECT current_setting('server_version_num') AS version");
    if (Math.floor(Number(version.version) / 10000) !== manifest.postgresMajor) throw Error('Restore drill PostgreSQL major must match the source');
    await admin.query(`CREATE DATABASE ${q(database)} TEMPLATE template0`);
    url.pathname = '/' + database;
    restored = clientFor(url.toString(), true); await restored.connect();
    await restored.query("SET timezone='UTC'; SET extra_float_digits=3; SET statement_timeout='10min'");
    for (const role of manifest.roles) {
      if (!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) await admin.query(`CREATE ROLE ${q(role)} NOLOGIN`);
    }
    for (const extension of manifest.extensions) {
      await restored.query(`CREATE SCHEMA IF NOT EXISTS ${q(extension.schema)}`);
      await restored.query(`CREATE EXTENSION IF NOT EXISTS ${q(extension.name)} WITH SCHEMA ${q(extension.schema)}`);
    }
    // template0 already provides public, also needed by pg_trgm/btree_gin.
    // Skip only its CREATE SCHEMA entry; restore every object and data entry.
    const toc = execFileSync(tool('pg_restore'), ['--list', dump], {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore','pipe','pipe']});
    const listFile = path.join(directory, `${database}.list`);
    fs.writeFileSync(listFile, toc.split('\n').filter(line => !/^\d+; \d+ \d+ SCHEMA - public /.test(line)).join('\n'), {mode: 0o600, flag: 'wx'});
    await command('pg_restore', ['--exit-on-error','--no-owner','--no-acl','--jobs=2','--use-list',listFile,'--dbname',database,dump], pgEnv(url.toString()), path.join(directory, 'restore.log'));
    const actual = await fingerprints(restored, await inventory(restored));
    compareTables(manifest.tables, actual);
    const integrity = (await restored.query(`SELECT count(*)::int AS invalid_indexes FROM pg_index i
      JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname=ANY($1::text[]) AND NOT i.indisvalid`, [SCHEMAS])).rows[0];
    if (integrity.invalid_indexes !== 0) throw Error('Restore contains invalid indexes');
    const result = {ok: true, checkedAt: new Date().toISOString(), seconds: Math.round((Date.now()-started)/1000),
      database, tables: actual.length, rows: actual.reduce((n,t) => n + BigInt(t.rows), 0n).toString(), archiveSha256: manifest.archive.sha256};
    writeJson(path.join(directory, `restore-proof-${Date.now()}.json`), result);
    return result;
  } finally {
    if (restored) await restored.end();
    await admin.end();
    // Keep the isolated database for inspection; this command never drops databases.
  }
}
async function main() {
  process.umask(0o077);
  const [command, directory] = process.argv.slice(2);
  if (!directory) throw Error('Usage: database-backup.mjs create|verify-restore PRIVATE_DIRECTORY');
  const result = command === 'create'
    ? await createBackup(process.env.BACKUP_DATABASE_URL, path.resolve(directory))
    : command === 'verify-restore'
      ? await restoreDrill(process.env.RESTORE_TEST_DATABASE_URL, path.resolve(directory))
      : (() => {throw Error('Unknown backup command')})();
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(e => {console.error(e.message);process.exitCode=1});
