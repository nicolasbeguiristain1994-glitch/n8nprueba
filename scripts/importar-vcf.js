const { secureDatabaseTransport } = require('../frontend/lib/database-tls');
/**
 * Importa un archivo VCF de contactos a la plataforma con auto-tagging de casino.
 *
 * Regla de username: si el nombre del contacto tiene múltiples partes
 * (separadas por espacio o /), se elige la que termina en z, ze, zz o zs.
 * Esa es la cuenta del panel principal (zeus). Las otras son de otros paneles.
 *
 * Uso:
 *   node scripts/importar-vcf.js archivo.vcf "postgresql://..."
 *
 * Output: resumen de importación con auto-tagging
 */

const { Pool } = require('pg');
const fs   = require('fs');
const path = require('path');

const vcfPath = process.argv[2];
const connStr = process.argv[3];
const agent = (process.argv[4] || '').trim().toLowerCase();
if (!agent) { console.error('Indicá el agente como cuarto argumento; los contactos se identifican por agente y usuario.'); process.exit(1); }

if (!vcfPath || !connStr) {
  console.error('Uso: node scripts/importar-vcf.js <archivo.vcf> "postgresql://..."');
  process.exit(1);
}

const pool = new Pool({ ...secureDatabaseTransport(connStr), family: 4 });

// ── Extraer username del casino ───────────────────────────────────────────────
// Separa por espacio o / y elige la parte que termina en z, ze, zz, zs (panel zeus).
// Si ninguna termina en z, usa la primera parte.
function extractCasinoUsername(fn) {
  const parts = fn.split(/[\s\/]+/).map(p => p.trim()).filter(Boolean);
  if (parts.length === 1) return parts[0];
  const zPart = parts.find(p => /z[ezs]{0,2}$/i.test(p));
  return zPart || parts[0];
}

// ── Normalizar teléfono a E.164 ───────────────────────────────────────────────
function normalizePhone(raw) {
  let p = raw.replace(/[-\s()]/g, '');
  if (!p.startsWith('+')) p = '+' + p;
  if (!/^\+\d{7,15}$/.test(p)) return null;
  return p;
}

// ── Parsear VCF ───────────────────────────────────────────────────────────────
function parseVcf(filePath) {
  const vcf   = fs.readFileSync(filePath, 'utf8');
  const cards = vcf.split('BEGIN:VCARD').filter(c => c.trim());
  const contactos = [];
  const seen  = new Set();

  for (const card of cards) {
    const fnMatch  = card.match(/^FN:(.+)$/m);
    const telLines = [...card.matchAll(/^TEL[^:]*:(.+)$/gm)];
    if (!fnMatch) continue;

    const fn             = fnMatch[1].trim();
    const casinoUsername = extractCasinoUsername(fn);

    // Primer teléfono válido
    let phone = null;
    for (const tel of telLines) {
      const n = normalizePhone(tel[1].trim());
      if (n) { phone = n; break; }
    }

    if (!phone || seen.has(`${phone}:${casinoUsername.toLowerCase()}`)) continue;
    seen.add(`${phone}:${casinoUsername.toLowerCase()}`);
    contactos.push({ phone, name: casinoUsername, casino_username: casinoUsername, fn_original: fn });
  }

  return contactos;
}

async function main() {
  const contactos = parseVcf(vcfPath);
  console.log(`\n📂 Archivo: ${path.basename(vcfPath)}`);
  console.log(`   ${contactos.length} contactos válidos\n`);

  if (contactos.length === 0) { await pool.end(); return; }

  // Preview de resolución de usernames
  const conDobleNombre = contactos.filter(c => c.fn_original !== c.casino_username);
  if (conDobleNombre.length > 0) {
    console.log(`🔍 Resolución de nombres dobles (${conDobleNombre.length}):`);
    conDobleNombre.slice(0, 8).forEach(c =>
      console.log(`   "${c.fn_original}" → username: ${c.casino_username}`)
    );
    if (conDobleNombre.length > 8) console.log(`   ...y ${conDobleNombre.length - 8} más`);
    console.log();
  }

  // 1. Upsert contactos
  const [row] = (await pool.query(`
    WITH input AS (
      SELECT phone, name FROM jsonb_to_recordset($1::jsonb) AS x(phone text, name text)
    ), upserted AS (
      INSERT INTO contacts
        (external_id, phone_number, first_name, status, opt_in_marketing, opt_in_sms, platform_source, created_at, updated_at,panel,panels_assigned,casino_accounts,account_username,identity_key)
      SELECT gen_random_uuid()::text, phone, NULLIF(name,''), 'active', true, true, 'import', NOW(), NOW(),contact_agent_key($2),ARRAY[contact_agent_key($2)],jsonb_build_array(jsonb_build_object('panel',contact_agent_key($2),'username',lower(trim(name)))),lower(trim(name)),jsonb_build_array(contact_agent_key($2),lower(trim(name)))::text
      FROM input
      ON CONFLICT (identity_key) DO UPDATE
        SET first_name = COALESCE(EXCLUDED.first_name, contacts.first_name), updated_at = NOW()
      RETURNING id, xmax::text
    )
    SELECT COUNT(*) FILTER (WHERE xmax='0') AS inserted, COUNT(*) FILTER (WHERE xmax!='0') AS updated
    FROM upserted
  `, [JSON.stringify(contactos.map(c => ({ phone: c.phone, name: c.name }))),agent])).rows;

  console.log(`✅ Contactos: ${row.inserted} nuevos, ${row.updated} actualizados`);

  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const {rows}=await client.query('SELECT id FROM contacts WHERE panel=contact_agent_key($1) AND account_username=ANY($2::text[])',[agent,contactos.map(c=>c.casino_username.toLowerCase())]);
    const {prepareSegmentation,applySegmentation}=require('../frontend/lib/casino-segmentation');
    await prepareSegmentation(client,{contactIds:rows.map(r=>r.id)});
    await applySegmentation(client,{updatePlayers:false});
    await client.query('COMMIT');
  } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();await pool.end();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
