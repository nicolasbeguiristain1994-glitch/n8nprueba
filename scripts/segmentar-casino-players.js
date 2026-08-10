#!/usr/bin/env node
/**
 * segmentar-casino-players.js
 *
 * Calcula y aplica seg_monto + seg_actividad en casino_players.
 *
 * seg_monto — basado en PROMEDIO de cargas sobre meses CON actividad real
 * (meses donde el jugador hizo al menos una carga en casino_transactions).
 * No penaliza los meses que no jugó.
 *
 *   bajo      → < $100.000/mes activo
 *   medio     → $100.000 – $499.999/mes activo
 *   vip       → $500.000 – $999.999/mes activo  (VIP Bajo)
 *   vip_medio → $1.000.000 – $1.500.000/mes activo
 *   vip_alto  → $1.500.001 – $3.199.999/mes activo
 *   super_vip → >= $3.200.000/mes activo
 *
 * seg_actividad (sin cambios):
 *   perdido    → fecha_ultima > 180 días atrás (o NULL)
 *   inactivo   → fecha_ultima 61–180 días atrás
 *   en_riesgo  → fecha_ultima 31–60 días atrás
 *   nuevo      → fecha_primera ≤ 30 días atrás (y activo)
 *   frecuente  → activo + freq_semanal ≥ 3
 *   regular    → activo + freq_semanal ≥ 1
 *   ocasional  → activo + freq_semanal < 1
 *
 * Idempotente: puede correrse múltiples veces.
 *
 * Uso:
 *   node scripts/segmentar-casino-players.js
 *   node scripts/segmentar-casino-players.js --dry-run
 *   DATABASE_URL="postgresql://..." node scripts/segmentar-casino-players.js
 */

'use strict'

const { Pool } = require('pg')
const fs       = require('fs')
const path     = require('path')

// ── .env ──────────────────────────────────────────────────────────────────────
;(function loadDotEnv() {
  const envPath = path.resolve(__dirname, '..', '.env')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    const k = t.slice(0, eq).trim()
    const v = t.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
    if (!(k in process.env)) process.env[k] = v
  }
})()

const DRY_RUN = process.argv.includes('--dry-run')

// seg_monto (el valor del jugador) sale de total_cargas / meses con actividad:
// no depende de qué día es hoy, así que es seguro recalcularlo aunque la sync
// del casino esté atrasada. seg_actividad sí depende de CURRENT_DATE — si los
// datos vienen con semanas de retraso, marca como "perdido" a gente que sigue
// jugando. Con --skip-actividad se actualiza solo el valor y se dejan intactos
// la actividad y sus tags, para recalcularlos después de resincronizar.
const SKIP_ACTIVIDAD = process.argv.includes('--skip-actividad')

if (!process.env.DATABASE_URL) {
  console.error('[seg] ERROR: DATABASE_URL no configurada.')
  process.exit(1)
}

const pool = new Pool({
  connectionString:        process.env.DATABASE_URL,
  connectionTimeoutMillis: 30_000,
  idleTimeoutMillis:       60_000,
})

const AGENTES = ['bigwin','ofizeus','betcoin','royal','farabet','zeus','zeusroyal','btcuno','btcdos']

// Umbrales de PROMEDIO MENSUAL sobre meses con actividad real (en pesos)
const THRESHOLD_MEDIO     =   100_000  // bajo      → < $100k/mes activo
const THRESHOLD_VIP       =   500_000  // medio     → $100k–$499k
const THRESHOLD_VIP_MEDIO = 1_000_000  // vip       → $500k–$999k
const THRESHOLD_VIP_ALTO  = 1_500_000  // vip_medio → $1M–$1.5M
const THRESHOLD_SUPER_VIP = 3_200_000  // vip_alto  → $1.5M–$3.2M  /  super_vip → >= $3.2M

// CTE que calcula meses activos, promedio mensual y FECHA REAL del último depósito
// usando casino_transactions (tipo='carga'). Usar casino_transactions como fuente
// de verdad para seg_actividad evita clasificar como "frecuente" a jugadores que
// tuvieron actividad hace meses y cuya casino_players.fecha_ultima esté desactualizada.
const CTE_MESES_ACTIVOS = `
  has_tx AS (
    SELECT EXISTS(SELECT 1 FROM casino_transactions WHERE tipo = 'carga') AS any_tx
  ),
  active_months AS (
    SELECT
      LOWER(ct.username)                                AS username_lower,
      COUNT(DISTINCT DATE_TRUNC('month', ct.fecha))::int AS meses_con_cargas,
      MAX(ct.fecha)::date                               AS last_tx_date
    FROM casino_transactions ct
    WHERE ct.tipo = 'carga'
    GROUP BY LOWER(ct.username)
  ),
  carga_mensual AS (
    SELECT
      cp.id,
      cp.username_lower,
      cp.total_cargas,
      COALESCE(am.meses_con_cargas, 1)             AS meses_activos,
      ROUND(
        cp.total_cargas::numeric /
        GREATEST(COALESCE(am.meses_con_cargas, 1), 1)
      )                                             AS avg_mensual,
      -- Si la sync ya corrió (casino_transactions tiene datos) pero este jugador
      -- no tiene registros, su última actividad es desconocida → NULL (perdido).
      -- Solo usamos casino_players.fecha_ultima como fallback si casino_transactions
      -- está completamente vacío (sync nunca ejecutada).
      CASE
        WHEN ht.any_tx AND am.last_tx_date IS NULL THEN NULL
        ELSE COALESCE(am.last_tx_date, cp.fecha_ultima)
      END                                          AS fecha_real_ultima
    FROM casino_players cp
    CROSS JOIN has_tx ht
    LEFT JOIN active_months am ON am.username_lower = cp.username_lower
    -- El valor de agente viene del casino sin normalizar: hay filas con espacio
    -- al final ('zeusroyal ', 'btcdos ') y con mayúsculas ('Admincab'), que con
    -- una comparación literal quedaban fuera y sin segmentar.
    WHERE LOWER(TRIM(cp.agente)) = ANY($6::text[])
  )
`

// Largo mínimo de token para considerarlo un posible username. Por debajo de 4
// los fragmentos genéricos que deja el import ("z", "zz", "bt") empiezan a
// colisionar con usernames reales de otros jugadores.
const MIN_TOKEN_LEN = 4

// Lista de agentes en formato SQL, ya normalizada, para filtrar dentro de los CTE.
const AGENTES_SQL = AGENTES.map(a => `'${a.replace(/'/g, "''")}'`).join(', ')

// Tokens que jamás deben tomarse como username, aunque exista un jugador con ese
// nombre. Los operadores anotan la plataforma dentro del nombre del contacto
// ("Mabel18z(Farabet)", "Betcoin Reclamos", "Maria16 (Zeus y Farabet)") y del otro
// lado existen cuentas administrativas homónimas —'betcoin' y 'bigwin' del agente
// adminbet, con $21M y $10M en cargas—. Sin esta lista, las líneas internas del
// negocio terminan clasificadas como super_vip y entran en campañas de VIP.
const TOKENS_PROHIBIDOS = [
  'farabet', 'betcoin', 'bigwin', 'royal', 'ofizeus', 'zeus', 'zeusroyal',
  'btcuno', 'btcdos',   // los mismos agentes, como se llaman en Bet30
  'adminbet', 'surmar', 'lemon', 'apolo', 'horus', 'peaky', 'soporte',
  'reclamos', 'linea', 'admin', 'mismo', 'usuario', 'titular', 'carga', 'mucho',
]
const TOKENS_PROHIBIDOS_SQL = TOKENS_PROHIBIDOS.map(t => `'${t}'`).join(', ')

// Vínculo contacto ↔ cuenta(s) de casino, y segmento agregado por contacto.
//
// No se puede joinear por teléfono: casino_players no lo tiene. El único nexo es
// el username, que el import dejó dentro de first_name y casi siempre sucio:
//   "Z/ Adrian249z"      → prefijo de línea pegado al username
//   "Zz adriana404zs"    → prefijo separado por espacio
//   "analia525zzz//analia525b" → dos cuentas de la misma persona en un campo
// Por eso se tokeniza por separadores no alfanuméricos y se matchea cada token.
//
// Un contacto con varias cuentas es UNA persona: su valor es la SUMA de lo que
// cargó en todas, no el de la cuenta que el join tomara primero.
const CTE_CONTACT_ACCOUNTS = `
  contact_accounts AS (
    SELECT DISTINCT c.id AS contact_id, cp.id AS player_id, cp.username_lower
    FROM contacts c
    CROSS JOIN LATERAL regexp_split_to_table(
      COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''),
      '[^a-zA-Z0-9]+'
    ) AS tok
    JOIN casino_players cp ON cp.username_lower = LOWER(tok)
    WHERE c.deleted_at IS NULL
      AND LENGTH(tok) >= ${MIN_TOKEN_LEN}
      AND LOWER(tok) NOT IN (${TOKENS_PROHIBIDOS_SQL})
      -- Solo agentes reales: 'adminbet' y 'surmar' son cuentas internas del
      -- negocio, no jugadores, y su volumen distorsiona cualquier segmento.
      AND LOWER(TRIM(cp.agente)) IN (${AGENTES_SQL})
  ),
  contact_cargas AS (
    SELECT ca.contact_id, SUM(cp.total_cargas)::numeric AS total_cargas
    FROM contact_accounts ca
    JOIN casino_players cp ON cp.id = ca.player_id
    GROUP BY 1
  ),
  -- Meses con actividad real contando todas las cuentas del contacto: si cargó
  -- en dos cuentas el mismo mes, ese mes cuenta una sola vez.
  contact_meses AS (
    SELECT ca.contact_id,
           COUNT(DISTINCT DATE_TRUNC('month', ct.fecha))::int AS meses_activos
    FROM contact_accounts ca
    JOIN casino_transactions ct
      ON LOWER(ct.username) = ca.username_lower AND ct.tipo = 'carga'
    GROUP BY 1
  ),
  contact_segmento AS (
    SELECT
      cc.contact_id,
      ROUND(cc.total_cargas / GREATEST(COALESCE(cm.meses_activos, 1), 1)) AS avg_mensual,
      CASE
        WHEN ROUND(cc.total_cargas / GREATEST(COALESCE(cm.meses_activos, 1), 1)) >= ${THRESHOLD_SUPER_VIP} THEN 'super_vip'
        WHEN ROUND(cc.total_cargas / GREATEST(COALESCE(cm.meses_activos, 1), 1)) >= ${THRESHOLD_VIP_ALTO}  THEN 'vip_alto'
        WHEN ROUND(cc.total_cargas / GREATEST(COALESCE(cm.meses_activos, 1), 1)) >= ${THRESHOLD_VIP_MEDIO} THEN 'vip_medio'
        WHEN ROUND(cc.total_cargas / GREATEST(COALESCE(cm.meses_activos, 1), 1)) >= ${THRESHOLD_VIP}       THEN 'vip'
        WHEN ROUND(cc.total_cargas / GREATEST(COALESCE(cm.meses_activos, 1), 1)) >= ${THRESHOLD_MEDIO}     THEN 'medio'
        ELSE 'bajo'
      END AS seg_monto
    FROM contact_cargas cc
    LEFT JOIN contact_meses cm ON cm.contact_id = cc.contact_id
  ),
  -- Perfil de la persona consolidando todas sus cuentas: la actividad se toma de
  -- la cuenta usada más recientemente (si juega en una sigue activo, aunque haya
  -- abandonado la otra) y la antigüedad, de la primera cuenta que abrió.
  contact_perfil AS (
    SELECT
      ca.contact_id,
      MIN(cp.fecha_primera)     AS fecha_primera,
      MAX(cp.fecha_ultima)      AS fecha_ultima,
      SUM(cp.cant_cargas)::int  AS cant_cargas,
      SUM(cp.cant_retiros)::int AS cant_retiros,
      (ARRAY_AGG(cp.seg_actividad ORDER BY cp.fecha_ultima DESC NULLS LAST))[1] AS seg_actividad
    FROM contact_accounts ca
    JOIN casino_players cp ON cp.id = ca.player_id
    GROUP BY 1
  )
`

// Fragmento del SET del paso 1. Se omite con --skip-actividad.
const SET_SEG_ACTIVIDAD = SKIP_ACTIVIDAD ? '' : `
      -- seg_actividad usa fecha_real_ultima para no clasificar como activo
      -- a jugadores cuya casino_players.fecha_ultima esté desactualizada
      seg_actividad = CASE
        WHEN cm.fecha_real_ultima IS NULL
          OR (CURRENT_DATE - cm.fecha_real_ultima) > 180          THEN 'perdido'
        WHEN (CURRENT_DATE - cm.fecha_real_ultima) >  60          THEN 'inactivo'
        WHEN (CURRENT_DATE - cm.fecha_real_ultima) >  30          THEN 'en_riesgo'
        WHEN cp.fecha_primera IS NOT NULL
          AND (CURRENT_DATE - cp.fecha_primera) <= 30             THEN 'nuevo'
        WHEN cp.fecha_primera IS NOT NULL
          AND (cp.cant_cargas::numeric
               / GREATEST((CURRENT_DATE - cp.fecha_primera)::numeric / 7.0, 1)) >= 3
                                                                  THEN 'frecuente'
        WHEN cp.fecha_primera IS NOT NULL
          AND (cp.cant_cargas::numeric
               / GREATEST((CURRENT_DATE - cp.fecha_primera)::numeric / 7.0, 1)) >= 1
                                                                  THEN 'regular'
        ELSE                                                           'ocasional'
      END,
`

async function main() {
  console.log('')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('  casino_players — segmentación por promedio mensual de cargas')
  if (DRY_RUN) console.log('  *** DRY RUN — no se modificará nada ***')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('')
  console.log('  Criterio: promedio sobre meses CON actividad (no meses totales)')
  console.log('  Umbrales:')
  console.log(`    bajo      →       $0  a  $${Number(THRESHOLD_MEDIO - 1).toLocaleString('es-AR')}/mes activo`)
  console.log(`    medio     → $${Number(THRESHOLD_MEDIO).toLocaleString('es-AR')}  a  $${Number(THRESHOLD_VIP - 1).toLocaleString('es-AR')}/mes activo`)
  console.log(`    vip       → $${Number(THRESHOLD_VIP).toLocaleString('es-AR')}  a  $${Number(THRESHOLD_VIP_MEDIO - 1).toLocaleString('es-AR')}/mes activo`)
  console.log(`    vip_medio → $${Number(THRESHOLD_VIP_MEDIO).toLocaleString('es-AR')}  a  $${Number(THRESHOLD_VIP_ALTO - 1).toLocaleString('es-AR')}/mes activo`)
  console.log(`    vip_alto  → $${Number(THRESHOLD_VIP_ALTO).toLocaleString('es-AR')}  a  $${Number(THRESHOLD_SUPER_VIP - 1).toLocaleString('es-AR')}/mes activo`)
  console.log(`    super_vip → $${Number(THRESHOLD_SUPER_VIP).toLocaleString('es-AR')}+/mes activo`)
  console.log('')

  if (DRY_RUN) {
    const previewRes = await pool.query(`
      WITH ${CTE_MESES_ACTIVOS}
      SELECT
        CASE
          WHEN cm.avg_mensual >= $1 THEN 'super_vip'
          WHEN cm.avg_mensual >= $2 THEN 'vip_alto'
          WHEN cm.avg_mensual >= $3 THEN 'vip_medio'
          WHEN cm.avg_mensual >= $4 THEN 'vip'
          WHEN cm.avg_mensual >= $5 THEN 'medio'
          ELSE                          'bajo'
        END AS seg_correcto,
        COUNT(*)::int AS n,
        ROUND(AVG(cm.avg_mensual)) AS avg_mensual_grupo,
        ROUND(AVG(cm.meses_activos), 1) AS avg_meses_activos
      FROM carga_mensual cm
      GROUP BY 1 ORDER BY 1
    `, [THRESHOLD_SUPER_VIP, THRESHOLD_VIP_ALTO, THRESHOLD_VIP_MEDIO, THRESHOLD_VIP, THRESHOLD_MEDIO, AGENTES])

    console.log('  DRY RUN — distribución estimada de seg_monto:')
    for (const r of previewRes.rows) {
      console.log(`    ${r.seg_correcto.padEnd(10)} ${Number(r.n).toLocaleString('es-AR').padStart(6)} jugadores  (avg $${Number(r.avg_mensual_grupo).toLocaleString('es-AR')}/mes · ${r.avg_meses_activos} meses activos prom.)`)
    }
    console.log('')
    console.log('  Volvé a correr sin --dry-run para aplicar.')
    await pool.end()
    return
  }

  // ── Paso 1: Actualizar casino_players ────────────────────────────────────────
  const updateRes = await pool.query(`
    WITH ${CTE_MESES_ACTIVOS}
    UPDATE casino_players cp
    SET
      freq_semanal = CASE
        WHEN cp.fecha_primera IS NOT NULL AND (CURRENT_DATE - cp.fecha_primera) > 0
          THEN ROUND(
            cp.cant_cargas::numeric
              / GREATEST((CURRENT_DATE - cp.fecha_primera)::numeric / 7.0, 1),
            2
          )
        ELSE 0
      END,

      -- Usar fecha_real_ultima (de casino_transactions si hay datos, sino casino_players)
      dias_desde_ultimo = CASE
        WHEN cm.fecha_real_ultima IS NOT NULL THEN (CURRENT_DATE - cm.fecha_real_ultima)
        ELSE NULL
      END,

      seg_monto = CASE
        WHEN cm.avg_mensual >= $1 THEN 'super_vip'
        WHEN cm.avg_mensual >= $2 THEN 'vip_alto'
        WHEN cm.avg_mensual >= $3 THEN 'vip_medio'
        WHEN cm.avg_mensual >= $4 THEN 'vip'
        WHEN cm.avg_mensual >= $5 THEN 'medio'
        ELSE                          'bajo'
      END,

      ${SET_SEG_ACTIVIDAD}

      updated_at = NOW()
    FROM carga_mensual cm
    WHERE cm.id = cp.id
  `, [THRESHOLD_SUPER_VIP, THRESHOLD_VIP_ALTO, THRESHOLD_VIP_MEDIO, THRESHOLD_VIP, THRESHOLD_MEDIO, AGENTES])

  const updatedPlayers = updateRes.rowCount ?? 0

  // ── Paso 2: Sincronizar contacts.segment desde casino_players ────────────────
  //
  // Dos bugs históricos corregidos acá:
  //
  //  1. `c.segment::text != cp.seg_monto` evaluaba a NULL cuando el contacto no
  //     tenía segmento todavía, así que la fila no entraba en el UPDATE y el
  //     contacto quedaba sin segmentar para siempre. Justamente los contactos
  //     nuevos —los que más falta hacía segmentar— eran los que se salteaban.
  //     Con IS DISTINCT FROM, NULL cuenta como "distinto" y se completa.
  //
  //  2. El join exacto contra first_name perdía la mayoría de los contactos:
  //     el campo viene sucio del import ("Z/ Adrian249z", "Zz adriana404zs") y
  //     a veces trae varias cuentas juntas ("analia525zzz//analia525b").
  //     Ahora se resuelve por contact_accounts (ver CTE_CONTACT_ACCOUNTS).
  const syncRes = await pool.query(`
    WITH ${CTE_CONTACT_ACCOUNTS}
    UPDATE contacts c
    SET segment    = ca.seg_monto::contact_segment,
        updated_at = NOW()
    FROM contact_segmento ca
    WHERE ca.contact_id = c.id
      AND ca.seg_monto IS NOT NULL
      AND c.segment::text IS DISTINCT FROM ca.seg_monto
  `)
  const syncedContacts = syncRes.rowCount ?? 0

  // ── Paso 3: Sincronizar contact_tags de segmento desde casino_players ────────
  // Borra tags obsoletos y re-inserta los actuales para casino:actividad,
  // casino:antiguedad y casino:valor_riesgo. Esto corrige el drift que ocurre
  // cuando el segmento cambia pero los tags importados originalmente no se actualizan.
  // El borrado apunta a los contactos que vamos a re-taggear en el INSERT de
  // abajo. Antes se recortaba por AGENTES y por el join exacto de first_name, así
  // que a un contacto que dejaba de matchear le quedaban los tags viejos para
  // siempre; ahora ambos lados usan el mismo criterio (contact_accounts).
  let syncedTags = 0
  if (SKIP_ACTIVIDAD) {
    console.log('  → Tags de actividad/antigüedad/riesgo: SALTEADOS (--skip-actividad)')
  } else {
  await pool.query(`
    WITH ${CTE_CONTACT_ACCOUNTS}
    DELETE FROM contact_tags ct
    WHERE (ct.tag LIKE 'casino:actividad:%'
        OR ct.tag LIKE 'casino:antiguedad:%'
        OR ct.tag LIKE 'casino:valor_riesgo:%')
      AND ct.contact_id IN (SELECT contact_id FROM contact_perfil)
  `)

  const tagsRes = await pool.query(`
    WITH ${CTE_CONTACT_ACCOUNTS}
    INSERT INTO contact_tags (id, contact_id, tag, added_by, added_at)
    SELECT
      gen_random_uuid(),
      p.contact_id,
      unnest(array_remove(ARRAY[
        'casino:actividad:' || p.seg_actividad,
        CASE
          WHEN p.fecha_primera IS NULL                              THEN NULL
          WHEN (CURRENT_DATE - p.fecha_primera) <  30              THEN 'casino:antiguedad:nuevo'
          WHEN (CURRENT_DATE - p.fecha_primera) <  90              THEN 'casino:antiguedad:reciente'
          WHEN (CURRENT_DATE - p.fecha_primera) < 150              THEN 'casino:antiguedad:establecido'
          WHEN (CURRENT_DATE - p.fecha_primera) < 270              THEN 'casino:antiguedad:veterano'
          ELSE                                                          'casino:antiguedad:leal'
        END,
        CASE
          WHEN p.seg_actividad IN ('perdido','inactivo','en_riesgo')
            AND s.seg_monto IN ('super_vip','vip_alto','vip_medio','vip') THEN 'casino:valor_riesgo:critico'
          WHEN p.seg_actividad IN ('perdido','inactivo','en_riesgo')
            AND s.seg_monto = 'medio'                                     THEN 'casino:valor_riesgo:medio'
          WHEN p.seg_actividad IN ('perdido','inactivo','en_riesgo')
            AND s.seg_monto = 'bajo'                                      THEN 'casino:valor_riesgo:bajo'
          ELSE NULL
        END
      ], NULL)),
      'segmentar-script',
      NOW()
    FROM contact_perfil p
    JOIN contact_segmento s ON s.contact_id = p.contact_id
    WHERE p.seg_actividad IS NOT NULL
      AND s.seg_monto     IS NOT NULL
    ON CONFLICT (contact_id, tag) DO NOTHING
  `)
  syncedTags = tagsRes.rowCount ?? 0
  }

  // ── Paso 4: Sincronizar contadores de depósitos en contacts ──────────────────
  // contacts.total_deposits y last_deposit_at se inicializan en 0/NULL y nunca
  // se actualizan automáticamente. Sin esta sincronización, el badge
  // "1er dep. · 10d+" puede aparecer en contactos que ya tienen muchos depósitos.
  // Los contadores se suman sobre todas las cuentas del contacto: si tiene dos,
  // sus depósitos totales son los de ambas, no los de una sola.
  const depositSyncRes = await pool.query(`
    WITH ${CTE_CONTACT_ACCOUNTS}
    UPDATE contacts c
    SET
      total_deposits    = p.cant_cargas,
      total_withdrawals = p.cant_retiros,
      last_deposit_at   = p.fecha_ultima::timestamptz,
      updated_at        = NOW()
    FROM contact_perfil p
    WHERE p.contact_id = c.id
      AND p.fecha_ultima IS NOT NULL
      AND (
        c.total_deposits    IS DISTINCT FROM p.cant_cargas
        OR c.total_withdrawals IS DISTINCT FROM p.cant_retiros
        OR c.last_deposit_at::date IS DISTINCT FROM p.fecha_ultima
      )
  `)
  const syncedDeposits = depositSyncRes.rowCount ?? 0

  // ── Paso 5: Limpiar segmento de las líneas internas del negocio ──────────────
  //
  // Los números propios ("Betcoin 2", "OFI 1 Bigwin", "Soporte Farabet") habían
  // quedado marcados super_vip: matchearon las cuentas administrativas del agente
  // adminbet, que mueven decenas de millones. Con eso entraban en las campañas
  // dirigidas a VIP. Ya no reciben segmento nuevo —el matching excluye esos
  // agentes— pero hay que borrar el que arrastran.
  //
  // El criterio es conservador: solo alcanza a contactos que no matchean ningún
  // jugador real, cuyo nombre menciona una plataforma u oficina, y que NO tienen
  // ningún token con forma de username (letras+dígitos). Así "Betcoin 2" se
  // limpia pero "lautaro609zz Mismo Usuario Zeus Y Farabet" queda intacto.
  const nombreCompleto = `(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,''))`
  const limpiezaRes = await pool.query(`
    WITH ${CTE_CONTACT_ACCOUNTS}
    UPDATE contacts c
    SET segment = NULL, updated_at = NOW()
    WHERE c.deleted_at IS NULL
      AND c.segment IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM contact_accounts ca WHERE ca.contact_id = c.id)
      AND (
        (
          ${nombreCompleto} ~* '(betcoin|bigwin|royal|farabet|ofizeus|zeus|soporte|reclamos|difusi|\\mofi\\M|principal|linea)'
          AND ${nombreCompleto} !~* '[a-z]+[0-9]+[a-z0-9]*'
        )
        -- "Royal I13", "Royal 8": plataforma al inicio y seguida de un
        -- identificador corto de oficina, nunca de un username.
        OR ${nombreCompleto} ~* '^(betcoin|bigwin|royal|farabet|ofizeus)\\s+[a-z]?[0-9]{1,3}\\s*$'
      )
  `)
  const limpiados = limpiezaRes.rowCount ?? 0

  // ── Resultado ─────────────────────────────────────────────────────────────────
  const resultRes = await pool.query(`
    SELECT
      seg_monto,
      seg_actividad,
      COUNT(*)::int AS n
    FROM casino_players
    WHERE agente = ANY($1::text[])
    GROUP BY seg_monto, seg_actividad
    ORDER BY seg_monto, seg_actividad
  `, [AGENTES])

  const byMonto = {}
  const byAct   = {}
  for (const r of resultRes.rows) {
    byMonto[r.seg_monto]   = (byMonto[r.seg_monto]   || 0) + r.n
    byAct[r.seg_actividad] = (byAct[r.seg_actividad] || 0) + r.n
  }

  console.log('  Distribución seg_monto (tras corrección):')
  for (const [k, v] of Object.entries(byMonto).sort()) {
    console.log(`    ${k.padEnd(10)} ${Number(v).toLocaleString('es-AR')} jugadores`)
  }
  console.log('')
  console.log('  Distribución seg_actividad:')
  for (const [k, v] of Object.entries(byAct).sort()) {
    console.log(`    ${k.padEnd(12)} ${Number(v).toLocaleString('es-AR')} jugadores`)
  }

  // Los jugadores de agentes fuera de AGENTES nunca reciben seg_monto y por lo
  // tanto sus contactos quedan sin segmento. Es una decisión deliberada, pero
  // tiene que verse: en silencio parece que se segmentó todo cuando no fue así.
  const excluidosRes = await pool.query(`
    SELECT COALESCE(TRIM(agente), '(sin agente)') AS agente, COUNT(*)::int AS n
    FROM casino_players
    WHERE agente IS NULL OR LOWER(TRIM(agente)) <> ALL($1::text[])
    GROUP BY 1 ORDER BY 2 DESC
  `, [AGENTES])

  if (excluidosRes.rows.length) {
    const totalExcluidos = excluidosRes.rows.reduce((s, r) => s + r.n, 0)
    console.log('')
    console.log(`  ⚠  ${Number(totalExcluidos).toLocaleString('es-AR')} jugadores NO segmentados — su agente no está en AGENTES:`)
    for (const r of excluidosRes.rows) {
      console.log(`       ${r.agente.padEnd(16)} ${Number(r.n).toLocaleString('es-AR').padStart(6)}`)
    }
  }

  console.log('')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log(`  casino_players actualizados: ${Number(updatedPlayers).toLocaleString('es-AR')}`)
  console.log(`  contacts sincronizados:      ${Number(syncedContacts).toLocaleString('es-AR')}`)
  console.log(`  contact_tags resincronizados: ${Number(syncedTags).toLocaleString('es-AR')}`)
  console.log(`  líneas internas despegadas:  ${Number(limpiados).toLocaleString('es-AR')}`)
  console.log(`  contadores depósito sync'd:  ${Number(syncedDeposits).toLocaleString('es-AR')}`)
  console.log('  ✓  Segmentación completada.')
  console.log('')

  await pool.end()
}

main().catch(err => {
  console.error('\n[seg] Fatal:', err.message)
  pool.end()
  process.exit(1)
})
