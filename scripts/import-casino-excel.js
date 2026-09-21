#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const { Client } = require('pg')
const { spawnSync } = require('child_process')
const { discover, readFiles } = require('../src/casino-import/excel')

async function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const output = args.find(a => a.startsWith('--report='))?.slice(9) || 'outputs/casino-excel-import/report.json'
  const inputs = args.filter(a => !a.startsWith('--'))
  if (!inputs.length || args.some(a => a.startsWith('--') && !['--apply', '--dry-run', '--migrate', '--skip-segmentation'].includes(a) && !a.startsWith('--report='))) throw new Error('Uso: node scripts/import-casino-excel.js [--apply] [--migrate] [--skip-segmentation] [--report=ruta.json] archivo-o-directorio ...')
  if (apply && args.includes('--dry-run')) throw new Error('--apply y --dry-run son excluyentes')
  const { reports, transactions } = readFiles(discover(inputs))
  if (!reports.length) throw new Error('No se encontraron Excel transaccionales reconocidos')
  const summary = { mode: apply ? 'apply' : 'dry-run', files: reports, unique_transactions: transactions.length, platforms: {} }
  for (const t of transactions) {
    const p = summary.platforms[t.platform] ||= { rows: 0, cargas_cents: 0, retiros_cents: 0 }
    p.rows++; p[t.tipo === 'carga' ? 'cargas_cents' : 'retiros_cents'] += Math.round(Number(t.monto)*100)
  }
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, JSON.stringify(summary, null, 2))
  console.log(JSON.stringify({ mode: summary.mode, files: reports.length, unique_transactions: transactions.length, platforms: summary.platforms }))
  if (!apply) return
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida para --apply')
  const c = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 30000 })
  await c.connect()
  try {
    if (args.includes('--migrate')) {
      console.log('Aplicando esquema del importador...')
      await c.query(fs.readFileSync(path.join(__dirname, '../db/migrations/126_casino_excel_import.sql'), 'utf8'))
      console.log('Esquema verificado. Cargando movimientos...')
    }
    await c.query('BEGIN')
    await c.query("SET LOCAL lock_timeout='15s'")
    await c.query("SET LOCAL statement_timeout='180s'")
    await c.query("SELECT pg_advisory_xact_lock(hashtext('casino-excel-import'))")
    await c.query('CREATE TEMP TABLE excel_stage (LIKE casino_transactions INCLUDING DEFAULTS) ON COMMIT DROP')
    const columns = ['platform','agente','username','tipo','monto','fecha','fecha_hora_utc','source_id','id_rec','raw_detalles','source_file','source_row']
    for (let i=0; i<transactions.length; i+=1000) {
      const batch=transactions.slice(i,i+1000)
      await c.query(`INSERT INTO excel_stage (${columns.join(',')}) VALUES ${batch.map((_,j)=>'('+columns.map((_,k)=>'$'+(j*columns.length+k+1)).join(',')+')').join(',')}`, batch.flatMap(t=>columns.map(k=>t[k])))
    }
    // Same platform + external ID must mean the same operation. Do not silently
    // swallow hash collisions, corrected amounts, or ambiguous legacy ownership.
    const conflicts = await c.query(`SELECT s.platform,s.source_id FROM excel_stage s JOIN casino_transactions t
      ON (t.platform=s.platform OR t.platform IS NULL) AND t.id_rec=s.id_rec
      WHERE (t.platform IS NULL AND (lower(trim(t.agente))<>s.agente OR lower(t.username)<>s.username))
        OR (t.source_id IS NOT NULL AND t.source_id<>s.source_id)
        OR t.fecha<>s.fecha OR lower(t.username)<>s.username OR t.tipo<>s.tipo OR t.monto<>s.monto
        OR (t.platform=s.platform AND lower(trim(t.agente))<>s.agente)
      LIMIT 10`)
    if (conflicts.rowCount) throw new Error('Conflicto con registros existentes: '+JSON.stringify(conflicts.rows))
    // Already-present legacy operations are not re-imported or assigned a platform.
    const existing = await c.query(`SELECT count(*)::int n FROM excel_stage s WHERE EXISTS (
      SELECT 1 FROM casino_transactions t WHERE t.id_rec=s.id_rec AND (t.platform=s.platform OR t.platform IS NULL))`)
    const inserted = await c.query(`INSERT INTO casino_transactions (${columns.join(',')})
      SELECT ${columns.map(k=>'s.'+k).join(',')} FROM excel_stage s
      WHERE NOT EXISTS (SELECT 1 FROM casino_transactions t WHERE t.id_rec=s.id_rec AND (t.platform=s.platform OR t.platform IS NULL))
      ON CONFLICT (platform,source_id) WHERE source_id IS NOT NULL DO NOTHING`)
    for (const r of reports) await c.query(`INSERT INTO casino_excel_imports
      (sha256,source_file,platform,agente,month,coverage,detail_rows,excluded_rows) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (sha256) DO NOTHING`, [r.sha256,r.file,r.platform,r.agente,r.month,r.coverage,r.rows,r.excluded])
    const verification = await c.query(`SELECT s.platform,count(*)::int rows,sum(s.monto) FILTER(WHERE s.tipo='carga')::text cargas,
      sum(s.monto) FILTER(WHERE s.tipo='retiro')::text retiros
      FROM excel_stage s WHERE EXISTS (SELECT 1 FROM casino_transactions t WHERE t.id_rec=s.id_rec AND (t.platform=s.platform OR t.platform IS NULL)
       AND t.fecha=s.fecha AND lower(t.username)=s.username AND t.tipo=s.tipo AND t.monto=s.monto) GROUP BY 1`)
    if (verification.rows.reduce((n,r)=>n+r.rows,0)!==transactions.length) throw new Error('La verificación no cubre todos los movimientos')
    await c.query('COMMIT')
    Object.assign(summary,{ inserted: inserted.rowCount, already_present: existing.rows[0].n, verification: verification.rows, committed: true })
    fs.writeFileSync(output,JSON.stringify(summary,null,2))
    console.log(JSON.stringify({inserted:summary.inserted,already_present:summary.already_present,verification:summary.verification}))
  } catch(e) { await c.query('ROLLBACK'); throw e } finally { await c.end() }
  if (!args.includes('--skip-segmentation')) {
    const result=spawnSync(process.execPath,[path.join(__dirname,'segmentar-casino-players.js'),'--imported-only'],{stdio:'inherit',env:process.env})
    summary.segmentation_completed=result.status===0
    fs.writeFileSync(output,JSON.stringify(summary,null,2))
    if (result.status!==0) throw new Error('Transacciones confirmadas; falló la segmentación. Reejecutar scripts/segmentar-casino-players.js.')
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1})
