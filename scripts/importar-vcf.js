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

const { Pool } = require('/Users/nicobegui/Desktop/whatsapp-automation-platform/frontend/node_modules/pg');
const fs   = require('fs');
const path = require('path');

const vcfPath = process.argv[2];
const connStr = process.argv[3];

if (!vcfPath || !connStr) {
  console.error('Uso: node scripts/importar-vcf.js <archivo.vcf> "postgresql://..."');
  process.exit(1);
}

const pool = new Pool({ connectionString: connStr, ssl: { rejectUnauthorized: false }, family: 4 });

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

    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
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
        (external_id, phone_number, first_name, status, opt_in_marketing, opt_in_sms, platform_source, created_at, updated_at)
      SELECT gen_random_uuid()::text, phone, NULLIF(name,''), 'active', true, true, 'import', NOW(), NOW()
      FROM input
      ON CONFLICT (phone_number) DO UPDATE
        SET first_name = COALESCE(EXCLUDED.first_name, contacts.first_name), updated_at = NOW()
      RETURNING id, xmax::text
    )
    SELECT COUNT(*) FILTER (WHERE xmax='0') AS inserted, COUNT(*) FILTER (WHERE xmax!='0') AS updated
    FROM upserted
  `, [JSON.stringify(contactos.map(c => ({ phone: c.phone, name: c.name })))])).rows;

  console.log(`✅ Contactos: ${row.inserted} nuevos, ${row.updated} actualizados`);

  // 2. Auto-tagging + setear panel
  const tagRes = await pool.query(`
    WITH matched AS (
      SELECT c.id AS contact_id, cp.agente, cp.seg_monto, cp.seg_actividad
      FROM contacts c
      JOIN (
        SELECT phone, casino_username FROM jsonb_to_recordset($1::jsonb) AS x(phone text, casino_username text)
      ) inp ON c.phone_number = inp.phone
      JOIN casino_players cp ON cp.username_lower = LOWER(inp.casino_username)
      WHERE cp.seg_monto IS NOT NULL AND cp.seg_actividad IS NOT NULL AND cp.agente IS NOT NULL
    ),
    tags_insert AS (
      INSERT INTO contact_tags (id, contact_id, tag, added_by, added_at)
      SELECT gen_random_uuid(), contact_id,
        unnest(ARRAY[
          'casino:monto:'     || seg_monto,
          'casino:actividad:' || seg_actividad,
          'casino:agente:'    || agente
        ]),
        'system', NOW()
      FROM matched
      ON CONFLICT (contact_id, tag) DO NOTHING
    )
    UPDATE contacts SET panel = m.agente, updated_at = NOW()
    FROM matched m
    WHERE contacts.id = m.contact_id AND contacts.panel IS NULL
    RETURNING contacts.first_name, contacts.panel,
      (SELECT seg_monto FROM matched WHERE contact_id = contacts.id) AS seg_monto,
      (SELECT seg_actividad FROM matched WHERE contact_id = contacts.id) AS seg_actividad
  `, [JSON.stringify(contactos.map(c => ({ phone: c.phone, casino_username: c.casino_username })))]);

  const taggedCount = tagRes.rows.length;
  console.log(`✅ Auto-tagging: ${taggedCount}/${contactos.length} contactos con datos de casino\n`);

  if (taggedCount > 0) {
    console.log('CONTACTOS CON SEGMENTO ASIGNADO:');
    tagRes.rows.forEach(r =>
      console.log(`  ${(r.first_name||'').padEnd(28)} agente=${r.panel?.padEnd(10)} monto=${r.seg_monto?.padEnd(6)} actividad=${r.seg_actividad}`)
    );
  }

  const sinMatch = contactos.length - taggedCount;
  if (sinMatch > 0) {
    console.log(`\n  (${sinMatch} sin match en casino_players — no están en los agentes capturados)`);
  }

  console.log('\n══════════════════════════════════════════');
  console.log(`Total importados: ${Number(row.inserted) + Number(row.updated)}`);
  console.log(`Con segmento:     ${taggedCount}`);
  console.log(`Sin segmento:     ${sinMatch}`);
  console.log('══════════════════════════════════════════\n');

  await pool.end();
}

main().catch(e => { console.error('❌', e.message); pool.end(); process.exit(1); });
