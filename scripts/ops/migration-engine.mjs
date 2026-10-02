import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
const LOCK = [1380273235, 1296648018];
const TRACKING = 'app_migrations';

// PostgreSQL statement boundaries, including dollar bodies and nested comments.
export function splitSql(sql) {
  const statements = []; let start = 0, i = 0, quote = null, dollar = null, depth = 0, line = false, quoteEscape = false;
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1];
    if (line) { if (c === '\n') line = false; i++; continue; }
    if (depth) { if (c === '/' && n === '*') { depth++; i += 2; } else if (c === '*' && n === '/') { depth--; i += 2; } else i++; continue; }
    if (dollar) { if (sql.startsWith(dollar, i)) { i += dollar.length; dollar = null; } else i++; continue; }
    if (quote) {
      if (c === quote) { if (n === quote) i += 2; else { quote = null; i++; } }
      else if (c === '\\' && quote === "'" && quoteEscape) i += 2;
      else i++;
      continue;
    }
    if (c === '-' && n === '-') { line = true; i += 2; continue; }
    if (c === '/' && n === '*') { depth = 1; i += 2; continue; }
    if (c === "'" || c === '"') { quote = c; quoteEscape = c === "'" && /(?:^|\W)[eE]$/.test(sql.slice(Math.max(0, i - 2), i)); i++; continue; }
    if (c === '$') { const match = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/); if (match) { dollar = match[0]; i += dollar.length; continue; } }
    if (c === ';') { statements.push(sql.slice(start, i).trim()); start = i + 1; }
    i++;
  }
  if (quote || dollar || depth) throw Error('Unterminated SQL quote/comment');
  statements.push(sql.slice(start).trim());
  return statements.filter(s => stripComments(s).trim());
}
export function stripComments(sql) { return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim(); }

export function loadCatalog(root) {
  const baselinePath = path.join(root, 'db/migrations/baseline.json');
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const dir = path.join(root, 'db/migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql') && !f.endsWith('.verify.sql')).map(f => `db/migrations/${f}`);
  files.push('db/schema/init.sql');
  const migrations = files.sort().map(filename => {
    const sql = fs.readFileSync(path.join(root, filename), 'utf8');
    const checksum = sha256(sql); const historical = baseline.files[filename];
    if (historical && checksum !== historical) throw Error(`Historical migration changed: ${filename}`);
    if (!historical && (!/^db\/migrations\/\d{3,}_[a-z0-9_]+\.sql$/.test(filename) || Number(path.basename(filename).split('_')[0]) <= baseline.through)) throw Error(`New migrations must have a unique number greater than ${baseline.through}: ${filename}`);
    const header = sql.match(/^--\s*migrate:\s*(transactional|nontransactional|manual)\s*$/m);
    if (/^--\s*migrate:/m.test(sql) && !header) throw Error(`Unknown migration mode: ${filename}`);
    const mode = header?.[1] ?? 'transactional';
    const verificationPath = path.join(root, filename.replace(/\.sql$/, '.verify.sql'));
    const verification = fs.existsSync(verificationPath) ? fs.readFileSync(verificationPath, 'utf8') : null;
    let statements = splitSql(sql);
    if (!historical) {
      if (statements.some(s => /^(BEGIN|COMMIT|END|ABORT|ROLLBACK|PREPARE\s+TRANSACTION|START\s+TRANSACTION)\b/i.test(stripComments(s)))) throw Error(`The runner owns transactions: ${filename}`);
      if (mode === 'transactional' && statements.some(s => /^(?:CREATE|DROP|REINDEX)\b[\s\S]*\bCONCURRENTLY\b|^VACUUM\b|^ALTER\s+TYPE\b[\s\S]*\bADD\s+VALUE\b/i.test(stripComments(s)))) throw Error(`Explicit nontransactional/manual mode required: ${filename}`);
      if (mode !== 'transactional' && !verification) throw Error(`A .verify.sql postcondition is required: ${filename}`);
    }
    if (verification && (splitSql(verification).length !== 1 || !/^SELECT\b/i.test(stripComments(verification)))) throw Error(`Verification must be one SELECT returning ok: ${filename}`);
    return { filename, checksum, historical: !!historical, mode, statements, verification, verificationChecksum: verification ? sha256(verification) : null };
  });
  for (const filename of Object.keys(baseline.files)) if (!migrations.some(m => m.filename === filename)) throw Error(`Historical migration missing: ${filename}`);
  const numbers = new Set();
  for (const m of migrations.filter(m => !m.historical)) { const number = Number(path.basename(m.filename).split('_')[0]); if (numbers.has(number)) throw Error(`Duplicate migration number: ${number}`); numbers.add(number); }
  const digest = sha256(JSON.stringify(migrations.map(({filename, checksum, mode, verificationChecksum}) => ({filename, checksum, mode, verificationChecksum}))));
  return { baseline, migrations, digest };
}

export async function fingerprint(client) {
  const { rows } = await client.query(`
    SELECT 'column' kind, table_name || '.' || column_name name,
      jsonb_build_array(ordinal_position,data_type,udt_name,is_nullable,column_default,character_maximum_length,numeric_precision,numeric_scale)::text definition
    FROM information_schema.columns WHERE table_schema='public'
    UNION ALL SELECT 'constraint', c.relname || '.' || k.conname, pg_get_constraintdef(k.oid)
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
    UNION ALL SELECT 'index', indexname, indexdef FROM pg_indexes WHERE schemaname='public'
    UNION ALL SELECT 'view', c.relname, pg_get_viewdef(c.oid,true) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('v','m')
    UNION ALL SELECT 'enum', t.typname || '.' || e.enumsortorder, e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'
    UNION ALL SELECT 'function', p.oid::regprocedure::text, pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p')
    UNION ALL SELECT 'trigger', c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
    UNION ALL SELECT 'policy', tablename || '.' || policyname, jsonb_build_array(permissive,roles,cmd,qual,with_check)::text FROM pg_policies WHERE schemaname='public'
    UNION ALL SELECT 'relation', c.relname, jsonb_build_array(c.relkind,c.relrowsecurity,c.relforcerowsecurity)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m')
    ORDER BY kind,name,definition`);
  const objects = rows.map(({kind,name,definition}) => ({kind,name,sha256:sha256(definition)}));
  return { digest: sha256(JSON.stringify(objects)), objects };
}
async function initialized(client) { return !!(await client.query("SELECT to_regclass('app_migrations.ledger') AS ledger")).rows[0].ledger; }
async function initialize(client) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${TRACKING}; REVOKE ALL ON SCHEMA ${TRACKING} FROM PUBLIC;
    CREATE TABLE IF NOT EXISTS ${TRACKING}.ledger(filename text PRIMARY KEY, checksum text NOT NULL, mode text NOT NULL,
      verification_checksum text, status text NOT NULL CHECK(status IN ('baseline','applied','running','failed')),
      source_commit text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS ${TRACKING}.baselines(digest text PRIMARY KEY, deployment_id text NOT NULL, source_commit text NOT NULL, object_hashes jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS ${TRACKING}.steps(filename text REFERENCES ${TRACKING}.ledger(filename), step integer, checksum text NOT NULL, status text NOT NULL, PRIMARY KEY(filename,step));`);
}
export async function withMigrationLock(client, run) {
  const { rows } = await client.query('SELECT pg_try_advisory_lock($1,$2) AS locked', LOCK);
  if (!rows[0].locked) throw Error('Another migration process owns the lock');
  try { return await run(); } finally { await client.query('SELECT pg_advisory_unlock($1,$2)', LOCK); }
}
export async function status(client, catalog) {
  if (!await initialized(client)) return { managed:false, pending:catalog.migrations.filter(m => !m.historical).map(m=>m.filename), recorded:0 };
  const { rows } = await client.query(`SELECT * FROM ${TRACKING}.ledger ORDER BY filename`);
  for (const row of rows) {
    const m = catalog.migrations.find(m => m.filename === row.filename);
    if (!m) throw Error(`Recorded migration is missing: ${row.filename}`);
    if (m.checksum !== row.checksum || m.mode !== row.mode || m.verificationChecksum !== row.verification_checksum) throw Error(`Recorded migration checksum/mode differs: ${row.filename}`);
    if (!['baseline','applied'].includes(row.status)) throw Error(`Incomplete nontransactional migration needs reconciliation: ${row.filename}`);
  }
  const names = new Set(rows.map(r=>r.filename));
  if (catalog.migrations.some(m => m.historical && !names.has(m.filename))) throw Error('Incomplete historical baseline');
  return { managed:true, recorded:rows.length, pending:catalog.migrations.filter(m => !names.has(m.filename)).map(m=>m.filename) };
}
async function record(client,m,commit,state) {
  await client.query(`INSERT INTO ${TRACKING}.ledger(filename,checksum,mode,verification_checksum,status,source_commit) VALUES($1,$2,$3,$4,$5,$6)`, [m.filename,m.checksum,m.mode,m.verificationChecksum,state,commit]);
}
export async function adoptBaseline(client,catalog,commit) {
  return withMigrationLock(client,async()=>{
    if (await initialized(client)) throw Error('Database already managed; baseline cannot be replaced');
    await client.query('BEGIN');
    try {
      const actual = await fingerprint(client);
      if (!catalog.baseline.schemaDigest || actual.digest !== catalog.baseline.schemaDigest) throw Error('Schema does not match the reviewed baseline fingerprint');
      await initialize(client);
      await client.query(`INSERT INTO ${TRACKING}.baselines(digest,deployment_id,source_commit,object_hashes) VALUES($1,$2,$3,$4)`,[actual.digest,catalog.baseline.deploymentId,commit,JSON.stringify(actual.objects)]);
      for (const m of catalog.migrations.filter(m=>m.historical)) await record(client,m,commit,'baseline');
      await client.query('COMMIT'); return {baseline:true,recorded:catalog.migrations.filter(m=>m.historical).length,digest:actual.digest};
    } catch(e) { await client.query('ROLLBACK'); throw e; }
  });
}
async function verify(client,m) {
  if (!m.verification) throw Error(`Verification missing: ${m.filename}`);
  await client.query('BEGIN READ ONLY');
  try { const {rows}=await client.query(m.verification); if(rows.length!==1 || rows[0].ok!==true) throw Error(`Postcondition failed: ${m.filename}`); }
  finally { await client.query('ROLLBACK'); }
}
export async function applyMigrations(client,catalog,commit) {
  return withMigrationLock(client,async()=>{
    const current=await status(client,catalog);
    if(!current.managed) throw Error('Database has no reviewed baseline; use --baseline first');
    const applied=[];
    for(const name of current.pending){
      const m=catalog.migrations.find(m=>m.filename===name);
      if(m.mode==='manual') throw Error(`Manual migration requires external execution and --record-manual: ${name}`);
      if(m.mode==='transactional'){
        await client.query('BEGIN');
        try{ for(const sql of m.statements) await client.query(sql); await record(client,m,commit,'applied'); await client.query('COMMIT'); }
        catch(e){await client.query('ROLLBACK');throw e;}
      } else {
        await record(client,m,commit,'running');
        try{
          for(let i=0;i<m.statements.length;i++){
            await client.query(`INSERT INTO ${TRACKING}.steps VALUES($1,$2,$3,'running')`,[name,i,sha256(m.statements[i])]);
            await client.query(m.statements[i]);
            await client.query(`UPDATE ${TRACKING}.steps SET status='applied' WHERE filename=$1 AND step=$2`,[name,i]);
          }
          await verify(client,m);
          await client.query(`UPDATE ${TRACKING}.ledger SET status='applied' WHERE filename=$1`,[name]);
        }catch(e){await client.query(`UPDATE ${TRACKING}.ledger SET status='failed' WHERE filename=$1`,[name]);throw e;}
      }
      applied.push(name);
    }
    return {applied};
  });
}
export async function reconcile(client,catalog,commit,filename,manual=false){
  return withMigrationLock(client,async()=>{
    if(!await initialized(client))throw Error('Database is not managed');
    const m=catalog.migrations.find(m=>m.filename===filename);
    if(!m || m.historical || m.mode!==(manual?'manual':'nontransactional'))throw Error('Invalid reconciliation target');
    const {rows}=await client.query(`SELECT * FROM ${TRACKING}.ledger WHERE filename=$1`,[filename]);
    if(manual&&rows.length)throw Error('Migration already recorded');
    if(!manual&&(!rows.length||rows[0].checksum!==m.checksum||rows[0].verification_checksum!==m.verificationChecksum||!['failed','running'].includes(rows[0].status)))throw Error('No matching incomplete migration');
    await verify(client,m);
    if(manual)await record(client,m,commit,'applied');
    else await client.query(`UPDATE ${TRACKING}.ledger SET status='applied',source_commit=$2,recorded_at=now() WHERE filename=$1`,[filename,commit]);
    return {reconciled:filename};
  });
}
