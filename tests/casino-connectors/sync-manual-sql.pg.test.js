'use strict'

/**
 * Integración contra PostgreSQL LOCAL de los scripts manuales REALES:
 *   db/manual/125_backfill_platform_inequivocos.sql
 *   db/manual/125_repair_casino_players_aggregates.sql
 *
 * Solo corre con TEST_DATABASE_URL explícita (nunca DATABASE_URL) apuntando a un
 * Postgres local (ver tests/helpers/local-db-guard.js). Crea un schema temporal
 * único, aplica las migraciones mínimas y lo borra al terminar.
 *
 * Cómo se ejecutan los scripts sin modificarlos:
 *   - Se lee el archivo tal cual y se separa su terminador final (`ROLLBACK;`),
 *     verificando que exista y que ninguna sentencia del cuerpo cierre la
 *     transacción (COMMIT/END/ABORT/ROLLBACK/PREPARE TRANSACTION). `ON COMMIT
 *     DROP` de las tablas temporales no es un cierre y se acepta.
 *   - El cuerpo (BEGIN … último SELECT) se ejecuta en UNA conexión dedicada.
 *   - Antes del terminador, dentro de la misma transacción, el test inspecciona
 *     los efectos (y, en un caso, ejecuta en memoria verificaciones del propio
 *     archivo después de una manipulación de control).
 *   - Después se ejecuta el terminador del archivo y se comprueba que la foto
 *     completa previa quedó restaurada.
 *   El archivo nunca se reescribe ni se pasa a COMMIT.
 *
 * Los valores esperados están calculados a mano a partir de los fixtures; el
 * test no reimplementa la agregación.
 *
 *   TEST_DATABASE_URL=postgresql:///wa_test?host=/tmp npx jest sync-manual-sql
 */

const fs       = require('fs')
const path     = require('path')
const { Pool } = require('pg')

const { assertLocalTestUrl } = require('../helpers/local-db-guard')

const TEST_URL     = process.env.TEST_DATABASE_URL
const describeIfDb = TEST_URL ? describe : describe.skip

const ROOT = path.join(__dirname, '..', '..')
const MIGRATIONS = [
  '025_casino_players.sql',
  '028_casino_transactions.sql',
  '029_casino_player_labels.sql',
  '031_casino_transactions_timestamp.sql',
  '123_casino_players_platform.sql',
  '125_casino_sync_monitoring.sql',
]
const BACKFILL = path.join(ROOT, 'db', 'manual', '125_backfill_platform_inequivocos.sql')
const REPAIR   = path.join(ROOT, 'db', 'manual', '125_repair_casino_players_aggregates.sql')

// ── Lectura del script real ───────────────────────────────────────────────────

/** Quita comentarios `-- …` y `/* … *\/` (los scripts manuales no tienen literales con esos marcadores). */
function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

/**
 * Sentencias que terminan (o abandonan) la transacción del script: COMMIT, END,
 * ABORT, ROLLBACK (salvo ROLLBACK TO SAVEPOINT) y PREPARE TRANSACTION.
 * Se miran solo al INICIO de cada sentencia, así que `ON COMMIT DROP` de una
 * tabla temporal no cuenta. Si hubiera un bloque $$…$$ con ';' internos, un
 * falso positivo solo haría fallar el test (seguro).
 */
function transactionEnds(sql) {
  return stripComments(sql)
    .split(';')
    .map(s => s.trim())
    .filter(s => /^(COMMIT|END|ABORT)\b/i.test(s)
              || /^ROLLBACK\b(?!\s+(WORK\s+|TRANSACTION\s+)?TO\b)/i.test(s)
              || /^PREPARE\s+TRANSACTION\b/i.test(s))
}

/**
 * Separa el terminador final (`ROLLBACK;`) sin alterar el resto del texto.
 * Rechaza cualquier otra sentencia que cierre la transacción en el cuerpo: si
 * existiera, lo que sigue se ejecutaría fuera de ella y quedaría escrito.
 */
function splitSql(sql, name) {
  const trimmed = sql.trimEnd()
  const m       = /(^|\n)(ROLLBACK;)$/.exec(trimmed)
  if (!m) throw new Error(`${name} no termina en ROLLBACK;`)

  const body       = trimmed.slice(0, m.index + m[1].length)
  const terminator = m[2]

  const ends = transactionEnds(body)
  if (ends.length) throw new Error(`${name} cierra la transacción antes del final: ${ends.join(' | ')}`)
  if (!/^BEGIN\b/im.test(stripComments(body))) throw new Error(`${name} no abre transacción`)

  return { sql, body, terminator }
}

const splitScript = file => splitSql(fs.readFileSync(file, 'utf8'), path.basename(file))

/** Texto de una sección del cuerpo entre dos marcadores de comentario del archivo. */
function section(body, startMarker, endMarker) {
  const start = body.indexOf(startMarker)
  const end   = body.indexOf(endMarker, start + startMarker.length)
  if (start < 0 || end < 0) throw new Error(`Sección ${startMarker} no encontrada`)
  return body.slice(start, end)
}

/** Resultado de un SELECT del script identificado por el nombre de una columna. */
function resultWith(results, column) {
  const r = results.find(x => x.fields?.some(f => f.name === column))
  if (!r) throw new Error(`El script no devolvió la columna ${column}`)
  return r
}

const single = (results, column) => resultWith(results, column).rows[0][column]

// ── Detector de cierre de transacción (sin base de datos) ─────────────────────

describe('splitSql — protección contra cierres de transacción', () => {
  const repairSql   = fs.readFileSync(REPAIR, 'utf8')
  const backfillSql = fs.readFileSync(BACKFILL, 'utf8')

  /** Inserta `stmt` justo antes del terminador final, solo en memoria. */
  const withBeforeTerminator = (sql, stmt) => sql.trimEnd().replace(/ROLLBACK;$/, `${stmt}\nROLLBACK;`)

  it('acepta los dos scripts reales; la reparación contiene ON COMMIT DROP fuera de comentarios', () => {
    expect(stripComments(repairSql)).toMatch(/ON COMMIT DROP/)
    expect(splitSql(repairSql, 'reparación').terminator).toBe('ROLLBACK;')
    expect(splitSql(backfillSql, 'backfill').terminator).toBe('ROLLBACK;')
  })

  it.each([
    ['COMMIT;'],
    ['commit ;'],
    ['END;'],
    ['end transaction;'],
    ['COMMIT AND CHAIN;'],
    ['ABORT;'],
    ['ROLLBACK;\nSELECT 1;'],
    ["PREPARE TRANSACTION 'x';"],
  ])('rechaza una sentencia activa %p antes del terminador', stmt => {
    expect(() => splitSql(withBeforeTerminator(repairSql, stmt), 'variante')).toThrow(/cierra la transacción/)
  })

  it.each([
    ['-- COMMIT;'],
    ['/* END; */'],
    ['CREATE TEMP TABLE _control ON COMMIT DROP AS SELECT 1;'],
    ['SAVEPOINT s; ROLLBACK TO SAVEPOINT s;'],
  ])('acepta %p (no cierra la transacción)', stmt => {
    expect(() => splitSql(withBeforeTerminator(repairSql, stmt), 'variante')).not.toThrow()
  })

  it('rechaza un script cuyo terminador no es ROLLBACK', () => {
    expect(() => splitSql(repairSql.trimEnd().replace(/ROLLBACK;$/, 'COMMIT;'), 'variante')).toThrow(/no termina en ROLLBACK/)
  })
})

describeIfDb('scripts manuales 125 — integración PostgreSQL local', () => {
  jest.setTimeout(30_000)

  let admin
  let pool
  let schema

  beforeAll(async () => {
    assertLocalTestUrl(TEST_URL)
    schema = `casino_manual_it_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
    admin  = new Pool({ connectionString: TEST_URL, max: 1 })
    await admin.query(`CREATE SCHEMA ${schema}`)
    pool = new Pool({ connectionString: TEST_URL, max: 3, options: `-c search_path=${schema}` })
    for (const file of MIGRATIONS) {
      await pool.query(fs.readFileSync(path.join(ROOT, 'db', 'migrations', file), 'utf8'))
    }
  })

  afterAll(async () => {
    if (pool)  await pool.end()
    if (admin) {
      if (schema) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await admin.end()
    }
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE casino_transactions, casino_players RESTART IDENTITY CASCADE')
  })

  /** Ejecuta el cuerpo del script en una conexión, inspecciona y aplica el terminador. */
  async function runScript(script, inspect) {
    const client = await pool.connect()
    let inTx = false
    try {
      inTx = true
      const results = [].concat(await client.query(script.body))
      const inspected = inspect ? await inspect(client, results) : undefined
      await client.query(script.terminator)
      inTx = false
      return { results, inspected }
    } finally {
      if (inTx) await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  }

  const tx = (cols) => pool.query(
    `INSERT INTO casino_transactions (platform, id_rec, fecha, agente, username, tipo, monto)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [cols.platform ?? null, cols.id ?? null, cols.fecha, cols.agente, cols.username, cols.tipo, cols.monto],
  )

  const playersSnapshot = async (db = pool) => Object.fromEntries((await db.query(
    `SELECT username_lower, to_jsonb(cp.*) AS row FROM casino_players cp ORDER BY username_lower`,
  )).rows.map(r => [r.username_lower, r.row]))

  const txSnapshot = async (db = pool) => (await db.query(
    `SELECT to_jsonb(ct.*) AS row FROM casino_transactions ct ORDER BY id`,
  )).rows.map(r => r.row)

  const AGG = ['total_cargas', 'total_retiros', 'cant_cargas', 'cant_retiros', 'fecha_primera', 'fecha_ultima']
  const withoutAgg = row => Object.fromEntries(Object.entries(row).filter(([k]) => !AGG.includes(k) && k !== 'updated_at'))

  // ── Reparación de agregados ─────────────────────────────────────────────────

  describe('125_repair_casino_players_aggregates.sql', () => {
    const repair = () => splitScript(REPAIR)
    const FIXED_UPDATED_AT = '2025-03-01T12:00:00+00:00'

    async function seedRepairFixture() {
      // juan: mayúsculas mixtas, tres plataformas (incluida NULL) y tres agentes.
      await tx({ platform: 'zeus',  id: 1,   fecha: '2025-01-10', agente: 'betcoin', username: 'Juan', tipo: 'carga',  monto: 1000 })
      await tx({ platform: 'bet30', id: 1,   fecha: '2025-02-10', agente: 'btcuno',  username: 'JUAN', tipo: 'carga',  monto: 500 })
      await tx({ platform: null,    id: 900, fecha: '2024-12-01', agente: 'viejo',   username: 'juan', tipo: 'retiro', monto: 200 })
      // movimiento entre agentes (username = agente, distinta capitalización): se excluye
      await tx({ platform: 'zeus',  id: 2,   fecha: '2025-01-15', agente: 'betcoin', username: 'BetCoin', tipo: 'carga', monto: 99999 })
      // ana: totales correctos, solo fecha_primera incorrecta
      await tx({ platform: 'zeus',  id: 3,   fecha: '2025-01-05', agente: 'betcoin', username: 'ana', tipo: 'carga', monto: 300 })
      await tx({ platform: null,    id: 901, fecha: '2025-01-20', agente: 'ofizeus', username: 'Ana', tipo: 'carga', monto: 200 })
      // pedro: ya correcto
      await tx({ platform: 'bet30', id: 4,   fecha: '2025-02-01', agente: 'btcdos',  username: 'pedro', tipo: 'retiro', monto: 100 })
      // nuevo: tiene movimientos pero no fila en casino_players (la reparación no inserta)
      await tx({ platform: 'zeus',  id: 5,   fecha: '2025-02-02', agente: 'royal',   username: 'nuevo', tipo: 'carga', monto: 50 })

      const player = p => pool.query(
        `INSERT INTO casino_players
           (username, agente, platform, user_id, total_cargas, cant_cargas, total_retiros, cant_retiros,
            freq_semanal, dias_desde_ultimo, fecha_primera, fecha_ultima, seg_monto, seg_actividad, labels, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [p.username, p.agente, p.platform, p.user_id ?? null, p.cargas, p.cantCargas, p.retiros, p.cantRetiros,
         p.freq ?? null, p.dias ?? null, p.primera, p.ultima, p.segMonto ?? null, p.segActividad ?? null,
         p.labels ?? [], FIXED_UPDATED_AT],
      )
      // Inactivo inflado por el bug anterior (totales/cantidades multiplicados)
      await player({ username: 'Juan', agente: 'betcoin', platform: 'zeus', user_id: 7, cargas: 4500, cantCargas: 6,
        retiros: 600, cantRetiros: 3, freq: 1.5, dias: 200, primera: '2024-12-01', ultima: '2025-02-10',
        segMonto: 'vip', segActividad: 'inactivo', labels: ['seguimiento', 'vip-manual'] })
      await player({ username: 'ana', agente: 'ofizeus', platform: null, cargas: 500, cantCargas: 2, retiros: 0, cantRetiros: 0,
        primera: '2025-01-01', ultima: '2025-01-20', segMonto: 'medio', segActividad: 'ocasional', labels: ['contactar'] })
      await player({ username: 'pedro', agente: 'btcdos', platform: 'bet30', cargas: 0, cantCargas: 0, retiros: 100, cantRetiros: 1,
        primera: '2025-02-01', ultima: '2025-02-01', segMonto: 'bajo' })
      // Sin transacciones que lo respalden
      await player({ username: 'sinfuente', agente: 'royal', platform: null, user_id: 99, cargas: 777, cantCargas: 7,
        retiros: 10, cantRetiros: 1, freq: 0.25, dias: 400, primera: '2023-01-01', ultima: '2023-06-01',
        segMonto: 'alto', segActividad: 'inactivo', labels: ['historico'] })
      // Fila fantasma del agente: su único movimiento es username = agente → sin fuente
      await player({ username: 'betcoin', agente: 'betcoin', platform: 'zeus', cargas: 99999, cantCargas: 1,
        retiros: 0, cantRetiros: 0, primera: '2025-01-15', ultima: '2025-01-15', segMonto: 'vip' })
    }

    it('corrige totales y fechas, informa ambas, preserva metadatos y restaura todo con su ROLLBACK', async () => {
      await seedRepairFixture()
      const beforePlayers = await playersSnapshot()
      const beforeTx      = await txSnapshot()

      const { results, inspected } = await runScript(repair(), async client => ({
        players: await playersSnapshot(client),
        tx:      await txSnapshot(client),
      }))

      // Informe previo del script: juan (totales) + ana (solo fechas)
      const informe = resultWith(results, 'jugadores_a_corregir').rows[0]
      expect(Number(informe.jugadores_con_fuente)).toBe(3)            // juan, ana, pedro
      expect(Number(informe.jugadores_a_corregir)).toBe(2)
      expect(Number(informe.con_totales_distintos)).toBe(1)
      expect(Number(informe.con_fechas_distintas)).toBe(1)
      expect(Number(informe.exceso_cargas)).toBe(3000)                // 4500 − (1000 + 500)
      expect(Number(informe.exceso_retiros)).toBe(400)                // 600 − 200
      expect(resultWith(results, 'primera_fuente').rows.map(r => r.username_lower).sort()).toEqual(['ana', 'juan'])

      const update = results.find(r => r.command === 'UPDATE')
      expect(update.rowCount).toBe(2)

      // Verificaciones del propio script
      for (const col of ['diferencias_restantes', 'delta_jugadores', 'segmentos_modificados', 'sin_fuente_modificados',
        'agente_o_platform_modificados', 'metadatos_modificados', 'updated_at_sin_cambio_de_datos']) {
        expect([col, Number(single(results, col))]).toEqual([col, 0])
      }

      // Efectos dentro de la transacción (antes del ROLLBACK del archivo)
      const after = inspected.players
      expect(after.juan).toMatchObject({
        total_cargas: 1500, total_retiros: 200, cant_cargas: 2, cant_retiros: 1,
        fecha_primera: '2024-12-01', fecha_ultima: '2025-02-10',
      })
      expect(after.ana).toMatchObject({ total_cargas: 500, cant_cargas: 2, fecha_primera: '2025-01-05', fecha_ultima: '2025-01-20' })
      // metadatos intactos; agente/platform NO se alinean (bloque opcional comentado)
      expect(withoutAgg(after.juan)).toEqual(withoutAgg(beforePlayers.juan))
      expect(withoutAgg(after.ana)).toEqual(withoutAgg(beforePlayers.ana))
      // (la fuente más reciente de juan es bet30/btcuno: el bloque 4b no se aplicó)
      expect(after.juan.agente).toBe('betcoin')
      expect(after.juan.updated_at).not.toBe(beforePlayers.juan.updated_at)
      // filas correctas o sin fuente: la fila completa, incluido updated_at
      expect(after.pedro).toEqual(beforePlayers.pedro)
      expect(after.sinfuente).toEqual(beforePlayers.sinfuente)
      expect(after.betcoin).toEqual(beforePlayers.betcoin)
      // no inserta ni borra jugadores; no toca transacciones
      expect(Object.keys(after).sort()).toEqual(Object.keys(beforePlayers).sort())
      expect(after.nuevo).toBeUndefined()
      expect(inspected.tx).toEqual(beforeTx)

      // Después del terminador del archivo: foto completa restaurada
      expect(await playersSnapshot()).toEqual(beforePlayers)
      expect(await txSnapshot()).toEqual(beforeTx)
    })

    it('las verificaciones del archivo detectan cambios indebidos (control negativo en memoria)', async () => {
      await seedRepairFixture()
      const beforePlayers = await playersSnapshot()
      const script = repair()
      const checks = section(script.body, '-- 5d.', '-- 5e.') +
                     section(script.body, '-- 5f.', '-- 5g.') +
                     script.body.slice(script.body.indexOf('-- 5g.'))

      const { inspected } = await runScript(script, async client => {
        // Manipulación de control, solo dentro de esta transacción
        await client.query(
          `UPDATE casino_players SET labels = ARRAY['alterado'], updated_at = NOW() - INTERVAL '1 day'
           WHERE username_lower = 'sinfuente'`)
        const r = [].concat(await client.query(checks))
        return {
          sinFuente:  Number(single(r, 'sin_fuente_modificados')),
          metadatos:  Number(single(r, 'metadatos_modificados')),
          updatedAt:  Number(single(r, 'updated_at_sin_cambio_de_datos')),
        }
      })

      expect(inspected).toEqual({ sinFuente: 1, metadatos: 1, updatedAt: 1 })
      expect(await playersSnapshot()).toEqual(beforePlayers)
    })

    it('es idempotente: sobre datos ya reparados no cambia nada (ni updated_at)', async () => {
      await seedRepairFixture()

      // 1ª ejecución: capturar en memoria el resultado reparado (el archivo hace ROLLBACK)
      const first = await runScript(repair(), async client => playersSnapshot(client))
      const repaired = first.inspected

      // Fixture: dejar la base como la dejaría la reparación, conservando updated_at original
      for (const row of Object.values(repaired)) {
        await pool.query(
          `UPDATE casino_players SET total_cargas = $2, total_retiros = $3, cant_cargas = $4, cant_retiros = $5,
                  fecha_primera = $6, fecha_ultima = $7
           WHERE username_lower = $1`,
          [row.username_lower, row.total_cargas, row.total_retiros, row.cant_cargas, row.cant_retiros,
           row.fecha_primera, row.fecha_ultima],
        )
      }
      const before = await playersSnapshot()

      // 2ª ejecución del mismo archivo
      const second = await runScript(repair(), async client => playersSnapshot(client))

      expect(Number(single(second.results, 'jugadores_a_corregir'))).toBe(0)
      expect(second.results.find(r => r.command === 'UPDATE').rowCount).toBe(0)
      expect(Number(single(second.results, 'diferencias_restantes'))).toBe(0)
      expect(Number(single(second.results, 'updated_at_sin_cambio_de_datos'))).toBe(0)
      expect(second.inspected).toEqual(before)
      expect(await playersSnapshot()).toEqual(before)
    })

    it('mientras retiene sus locks, otras escrituras fallan con 55P03; tras su ROLLBACK se completan', async () => {
      await seedRepairFixture()
      const beforePlayers = await playersSnapshot()
      const beforeTx      = await txSnapshot()

      const INSERT = `INSERT INTO casino_transactions (platform, id_rec, fecha, agente, username, tipo, monto)
                      VALUES ('zeus', 7777, '2025-03-01', 'royal', 'lockprobe', 'carga', 1)`
      const UPDATE = `UPDATE casino_players SET labels = ARRAY['lock-probe'] WHERE username_lower = 'sinfuente'`

      const other = await pool.connect()
      /** Intenta una escritura en su propia transacción con lock_timeout corto. */
      const tryWrite = async sql => {
        await other.query('BEGIN')
        try {
          await other.query("SET LOCAL lock_timeout = '200ms'")
          await other.query(sql)
          await other.query('COMMIT')
          return null
        } catch (err) {
          await other.query('ROLLBACK')
          return err
        }
      }

      try {
        const { inspected } = await runScript(repair(), async () => {
          // Leer sigue permitido (SHARE / SHARE ROW EXCLUSIVE no bloquean SELECT)
          const readable = (await other.query('SELECT COUNT(*)::int AS n FROM casino_players')).rows[0].n
          const insertErr = await tryWrite(INSERT)   // ROW EXCLUSIVE vs SHARE en casino_transactions
          const updateErr = await tryWrite(UPDATE)   // ROW EXCLUSIVE vs SHARE ROW EXCLUSIVE en casino_players
          return {
            readable,
            insertCode: insertErr?.code ?? null,
            updateCode: updateErr?.code ?? null,
          }
        })

        expect(inspected).toEqual({ readable: 5, insertCode: '55P03', updateCode: '55P03' })
        // Nada de lo intentado durante el bloqueo quedó escrito
        expect(await playersSnapshot()).toEqual(beforePlayers)
        expect(await txSnapshot()).toEqual(beforeTx)

        // Tras el ROLLBACK del archivo, las mismas escrituras se completan
        expect(await tryWrite(INSERT)).toBeNull()
        expect(await tryWrite(UPDATE)).toBeNull()
        expect((await pool.query(`SELECT COUNT(*)::int AS n FROM casino_transactions WHERE username = 'lockprobe'`)).rows[0].n).toBe(1)
        expect((await pool.query(`SELECT labels FROM casino_players WHERE username_lower = 'sinfuente'`)).rows[0].labels)
          .toEqual(['lock-probe'])
      } finally {
        // Limpiar el fixture de la prueba de bloqueo
        await other.query(`DELETE FROM casino_transactions WHERE username = 'lockprobe'`).catch(() => {})
        await other.query(`UPDATE casino_players SET labels = ARRAY['historico'] WHERE username_lower = 'sinfuente'`).catch(() => {})
        other.release()
      }

      expect(await playersSnapshot()).toEqual(beforePlayers)
      expect(await txSnapshot()).toEqual(beforeTx)
    })
  })

  // ── Backfill de plataforma ──────────────────────────────────────────────────

  describe('125_backfill_platform_inequivocos.sql', () => {
    const backfill = () => splitScript(BACKFILL)
    const platforms = async (db = pool) => Object.fromEntries((await db.query(
      `SELECT id_rec::text AS id, platform FROM casino_transactions WHERE id_rec IS NOT NULL ORDER BY id_rec`,
    )).rows.map(r => [r.id, r.platform]))

    async function seedBackfillFixture() {
      const legacy = [
        [10, 'betcoin'], [11, 'OfiZeus'], [12, 'royal'], [13, 'farabet'], [14, 'lasvegas'],
        [20, 'btcuno'], [21, 'btcdos'], [22, 'zeus'], [23, 'ZeusRoyal'],
        [30, 'bigwin'], [31, 'desconocido'],
      ]
      for (const [id, agente] of legacy) {
        await tx({ platform: null, id, fecha: '2025-01-01', agente, username: `p${id}`, tipo: 'carga', monto: id })
      }
      // Ya clasificadas: el backfill no las toca aunque el agente "diga" otra cosa
      await tx({ platform: 'zeus',  id: 40, fecha: '2025-01-01', agente: 'btcuno', username: 'p40', tipo: 'carga', monto: 1 })
      await tx({ platform: 'bet30', id: 41, fecha: '2025-01-01', agente: 'bigwin', username: 'p41', tipo: 'carga', monto: 1 })
    }

    it('asigna solo agentes inequívocos (zeus → bet30), deja bigwin/desconocidos y clasificados, y su ROLLBACK restaura', async () => {
      await seedBackfillFixture()
      const beforeTx = await txSnapshot()

      const { results, inspected } = await runScript(backfill(), async client => platforms(client))

      expect(inspected).toEqual({
        10: 'zeus', 11: 'zeus', 12: 'zeus', 13: 'zeus', 14: 'zeus',
        20: 'bet30', 21: 'bet30', 22: 'bet30', 23: 'bet30',
        30: null, 31: null,
        40: 'zeus', 41: 'bet30',
      })

      // Conteo previo del script: 11 filas sin plataforma
      const previo = resultWith(results, 'filas_null').rows
      expect(previo.reduce((s, r) => s + Number(r.filas_null), 0)).toBe(11)
      expect(previo.map(r => r.agente)).toContain('zeus')   // agente 'zeus' (de Bet30) en minúscula

      // Verificación del script: solo bigwin y desconocido quedan sin clasificar
      const sinClasificar = resultWith(results, 'filas').rows
        .filter(r => r.platform === '(NULL)')
        .map(r => [r.agente, Number(r.filas)])
      expect(sinClasificar).toEqual([['bigwin', 1], ['desconocido', 1]])

      expect(await txSnapshot()).toEqual(beforeTx)
    })

    it('una colisión por mayúsculas en filas sin ID hace fallar el UPDATE; el rollback preserva todo', async () => {
      await tx({ platform: null, fecha: '2025-01-01', agente: 'betcoin', username: 'Juan', tipo: 'carga', monto: 100 })
      await tx({ platform: null, fecha: '2025-01-01', agente: 'betcoin', username: 'juan', tipo: 'carga', monto: 100 })
      await tx({ platform: null, id: 20, fecha: '2025-01-01', agente: 'btcuno', username: 'x', tipo: 'carga', monto: 1 })
      const beforeTx = await txSnapshot()

      const err = await runScript(backfill()).catch(e => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.code).toBe('23505')
      expect(err.constraint).toBe('idx_casino_transactions_platform_dedup')

      expect(await txSnapshot()).toEqual(beforeTx)
    })

    it('una colisión de ID con una fila ya clasificada hace fallar el UPDATE; el rollback preserva todo', async () => {
      await tx({ platform: null,   id: 500, fecha: '2025-01-01', agente: 'betcoin', username: 'a', tipo: 'carga', monto: 1 })
      await tx({ platform: 'zeus', id: 500, fecha: '2025-01-02', agente: 'royal',   username: 'b', tipo: 'carga', monto: 2 })
      const beforeTx = await txSnapshot()

      const err = await runScript(backfill()).catch(e => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.code).toBe('23505')
      expect(err.constraint).toBe('idx_casino_transactions_platform_id_rec')

      expect(await txSnapshot()).toEqual(beforeTx)
      const rows500 = (await pool.query(
        `SELECT agente, platform FROM casino_transactions WHERE id_rec = 500 ORDER BY agente`)).rows
      expect(rows500).toEqual([{ agente: 'betcoin', platform: null }, { agente: 'royal', platform: 'zeus' }])
    })
  })
})
