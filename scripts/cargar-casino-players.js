/**
 * Carga (o actualiza) los datos de segmentación de jugadores en la DB.
 *
 * Lee exports/jugadores_metricas.json y hace un upsert masivo en casino_players.
 *
 * Uso:
 *   node scripts/cargar-casino-players.js
 *
 * Requiere variable de entorno DATABASE_URL (o usa .env.local del frontend).
 */

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const METRICS_FILE = path.join(__dirname, '../exports/jugadores_metricas.json');

// ── Conexión ──────────────────────────────────────────────────────────────────
// Pasar como argumento: node scripts/cargar-casino-players.js "postgresql://..."
// O como variable de entorno: DATABASE_URL=... node scripts/cargar-casino-players.js
// O con Doppler: doppler run -- node scripts/cargar-casino-players.js
const connectionString = process.argv[2] || process.env.DATABASE_URL

if (!connectionString) {
  console.error('❌ Falta connection string de la DB.')
  console.error('')
  console.error('Opciones:')
  console.error('  node scripts/cargar-casino-players.js "postgresql://user:pass@host:5432/db"')
  console.error('  DATABASE_URL=postgresql://... node scripts/cargar-casino-players.js')
  console.error('  doppler run -- node scripts/cargar-casino-players.js')
  process.exit(1)
}

async function main() {
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

  console.log('📂 Leyendo jugadores_metricas.json...');
  const jugadores = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8'));
  console.log(`   ${jugadores.length} jugadores a cargar`);

  // Crear tabla si no existe (por si la migración no fue aplicada aún)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS casino_players (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username        VARCHAR(100) NOT NULL,
      username_lower  VARCHAR(100) GENERATED ALWAYS AS (LOWER(username)) STORED,
      agente          VARCHAR(50),
      user_id         INTEGER,
      total_cargas    BIGINT  DEFAULT 0,
      cant_cargas     INTEGER DEFAULT 0,
      total_retiros   BIGINT  DEFAULT 0,
      cant_retiros    INTEGER DEFAULT 0,
      freq_semanal    NUMERIC(6,2),
      dias_desde_ultimo INTEGER,
      fecha_primera   DATE,
      fecha_ultima    DATE,
      seg_monto       VARCHAR(20),
      seg_actividad   VARCHAR(20),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_casino_players_username_lower
      ON casino_players (username_lower)
  `);

  // Upsert en lotes de 500
  const BATCH = 500;
  let total = 0;
  let inserted = 0;
  let updated  = 0;

  for (let i = 0; i < jugadores.length; i += BATCH) {
    const lote = jugadores.slice(i, i + BATCH);

    const rows = lote.map(j => ({
      username:         j.username,
      agente:           j.agente || null,
      user_id:          j.user_id ? Number(j.user_id) : null,
      total_cargas:     Number(j.totalCargas)   || 0,
      cant_cargas:      Number(j.cantCargas)    || 0,
      total_retiros:    Number(j.totalRetiros)  || 0,
      cant_retiros:     Number(j.cantRetiros)   || 0,
      freq_semanal:     j.freqSemanal  != null ? Number(j.freqSemanal)  : null,
      dias_desde_ultimo:j.diasDesdeUltimo != null ? Number(j.diasDesdeUltimo) : null,
      fecha_primera:    j.fechaPrimera || null,
      fecha_ultima:     j.fechaUltima  || null,
      seg_monto:        j.seg_monto    || null,
      seg_actividad:    j.seg_actividad|| null,
    }));

    const result = await pool.query(`
      WITH input AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS x(
          username        text,
          agente          text,
          user_id         int,
          total_cargas    bigint,
          cant_cargas     int,
          total_retiros   bigint,
          cant_retiros    int,
          freq_semanal    numeric,
          dias_desde_ultimo int,
          fecha_primera   date,
          fecha_ultima    date,
          seg_monto       text,
          seg_actividad   text
        )
      ), upserted AS (
        INSERT INTO casino_players
          (username, agente, user_id, total_cargas, cant_cargas,
           total_retiros, cant_retiros, freq_semanal, dias_desde_ultimo,
           fecha_primera, fecha_ultima, seg_monto, seg_actividad, updated_at)
        SELECT
          username, agente, user_id, total_cargas, cant_cargas,
          total_retiros, cant_retiros, freq_semanal, dias_desde_ultimo,
          fecha_primera, fecha_ultima, seg_monto, seg_actividad, NOW()
        FROM input
        ON CONFLICT (username_lower) DO UPDATE SET
          agente            = EXCLUDED.agente,
          user_id           = EXCLUDED.user_id,
          total_cargas      = EXCLUDED.total_cargas,
          cant_cargas       = EXCLUDED.cant_cargas,
          total_retiros     = EXCLUDED.total_retiros,
          cant_retiros      = EXCLUDED.cant_retiros,
          freq_semanal      = EXCLUDED.freq_semanal,
          dias_desde_ultimo = EXCLUDED.dias_desde_ultimo,
          fecha_primera     = EXCLUDED.fecha_primera,
          fecha_ultima      = EXCLUDED.fecha_ultima,
          seg_monto         = EXCLUDED.seg_monto,
          seg_actividad     = EXCLUDED.seg_actividad,
          updated_at        = NOW()
        RETURNING xmax::text
      )
      SELECT
        COUNT(*) FILTER (WHERE xmax = '0')  AS inserted,
        COUNT(*) FILTER (WHERE xmax != '0') AS updated
      FROM upserted
    `, [JSON.stringify(rows)]);

    inserted += Number(result.rows[0].inserted);
    updated  += Number(result.rows[0].updated);
    total    += lote.length;
    process.stdout.write(`\r  Procesados: ${total}/${jugadores.length} (${inserted} nuevos, ${updated} actualizados)`);
  }

  console.log('\n');
  console.log('══════════════════════════════════════');
  console.log(`✅ Carga completada`);
  console.log(`   Nuevos:      ${inserted}`);
  console.log(`   Actualizados: ${updated}`);
  console.log(`   Total:        ${total}`);
  console.log('══════════════════════════════════════');

  await pool.end();
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
