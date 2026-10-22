// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
vi.mock('@/lib/db',()=>({query:vi.fn()}))
import { casinoAgentSummary } from '../dashboard-agent-summary'
import { casinoDashboard } from '../dashboard-casino'
import type { query } from '../db'

describe.skipIf(process.env.RUN_DASHBOARD_PG_TESTS!=='1')('sales month comparison in PostgreSQL',()=>{
  it('uses original cash amounts, platform aliases and calendar months including prior-only agents',async()=>{
    const url=new URL(process.env.DATABASE_URL!)
    if(!['localhost','127.0.0.1'].includes(url.hostname))throw Error('Local database required')
    const db=new Client({connectionString:url.toString(),ssl:false});await db.connect()
    try {
      await db.query(`BEGIN;
        CREATE TEMP TABLE casino_transactions(id bigint,id_rec bigint,platform text,agente text,username text,tipo text,monto numeric,fecha date,fecha_hora_utc timestamptz,raw_detalles text) ON COMMIT DROP;
        CREATE TEMP TABLE casino_financial_source_records(platform text,source_id text,kind text,transaction_id bigint,agente text,username text,monto numeric,fecha date,fecha_hora_utc timestamptz) ON COMMIT DROP;
        CREATE TEMP TABLE casino_dashboard_players(platform text,username_lower text,agente text,first_deposit_agent text,fecha_primera date,fecha_ultima date,seg_monto text,seg_actividad text,total_cargas numeric,cant_cargas int,total_retiros numeric,cant_retiros int) ON COMMIT DROP;
        INSERT INTO casino_transactions(id,platform,agente,username,tipo,monto,fecha,fecha_hora_utc,raw_detalles) VALUES
          (1,'zeus','royal','a','carga',100,'2026-08-01',NULL,NULL),
          (2,'zeus','royal','a','carga',200,'1900-01-01','2026-09-01T03:00:00Z',NULL),
          (3,'ganamos','adminroyal','a','carga',50,'2026-08-31',NULL,NULL),
          (4,'bet30','zeusroyal','a','carga',100.13,'2026-10-01','2026-10-01T02:59:59Z',NULL),
          (5,'argenbet','adminroyal','a','carga',25.01,'2026-09-10',NULL,NULL),
          (6,'zeus','bigwin','b','carga',300,'2026-08-15',NULL,NULL),
          (7,'zeus','bigwin','b','carga',150,'2026-09-15',NULL,NULL),
          (8,'zeus','farabet','c','carga',25,'2026-09-15',NULL,NULL),
          (9,'zeus','imperio','d','carga',10,'2026-08-15',NULL,NULL),
          (10,'zeus','royal','a','carga',999,'2026-08-01','2026-08-01T02:59:59Z',NULL),
          (11,'zeus','royal','a','carga',999,'2026-10-01','2026-10-01T03:00:00Z',NULL),
          (12,'zeus','royal','a','carga',999,'2026-09-15',NULL,' Bono '),
          (13,'zeus','royal','a','retiro',999,'2026-09-15',NULL,NULL),
          (14,NULL,'royal','a','carga',999,'2026-09-15',NULL,NULL);
        INSERT INTO casino_financial_source_records VALUES
          ('bet30','4','importe_original',4,'zeusroyal','a',100.125,'2026-09-30',NULL),
          ('argenbet','5','importe_original',5,'adminroyal','a',25.005,'2026-09-10',NULL),
          ('bet30','bonus','bono',NULL,'zeusroyal','a',999,'2026-09-15',NULL);`)
      const run=(async(sql:string,params?:unknown[])=>(await db.query(sql,params)).rows) as typeof query
      const all=await casinoDashboard('consolidado','2026-09-01','2026-09-30',null,run)
      expect(all.sales_comparison?.previous).toEqual({from:'2026-08-01',to:'2026-08-31'})
      const rows=all.sales_comparison!.rows
      const royal=rows.find(r=>r.agente==='royal')!
      expect(Number(royal.amount)).toBe(325.13)
      expect(Number(royal.previous_amount)).toBe(150)
      expect(Number(royal.difference)).toBe(175.13)
      expect(Number(royal.change_percentage)).toBe(116.75)
      expect(rows.find(r=>r.agente==='bigwin')).toMatchObject({change_percentage:'-50.00'})
      expect(rows.find(r=>r.agente==='imperio')).toMatchObject({amount:'0',change_percentage:'-100.00'})
      expect(rows.find(r=>r.agente==='farabet')).toMatchObject({previous_amount:'0',change_percentage:null})
      expect(rows.find(r=>r.agente==='ofizeus')).toMatchObject({amount:'0',previous_amount:'0',change_percentage:'0'})
      expect(rows.some(r=>r.agente==='adminroyal'||r.agente==='zeusroyal')).toBe(false)
      expect(rows.reduce((s,r)=>s+Number(r.amount),0)).toBeCloseTo(all.agentes.reduce((s,r)=>s+r.sum_cargas,0),8)
      // Widening the ledger for August 1 must not alter the pre-existing equal-duration KPIs.
      expect(all.summary.activos_anterior).toBe(3)
      const zeus=await casinoDashboard('zeus','2026-09-01','2026-09-30',null,run)
      expect(zeus.sales_comparison!.rows.find(r=>r.agente==='royal')).toMatchObject({amount:'200',previous_amount:'100',change_percentage:'100.00'})
      const filtered=await casinoDashboard('consolidado','2026-09-01','2026-09-30','royal',run)
      expect(filtered.sales_comparison!.rows).toHaveLength(1)
      const partial=await casinoDashboard('consolidado','2026-09-01','2026-09-15',null,run)
      expect(partial.sales_comparison!.previous).toEqual({from:'2026-08-01',to:'2026-08-15'})
      expect(Number(partial.sales_comparison!.rows.find(r=>r.agente==='royal')!.previous_amount)).toBe(100)
      // Fast cards must agree with the complete account report, including moved
      // accounts, first-deposit attribution, aliases, zero sales and hidden agents.
      await db.query(`INSERT INTO casino_dashboard_players(platform,username_lower,agente,first_deposit_agent,fecha_primera) VALUES
        ('zeus','a','farabet','royal','2026-09-01'),
        ('bet30','a','zeusroyal','zeusroyal','2026-09-30'),
        ('ganamos','other','duendeverde','duendeverde','2026-09-10'),
        ('zeus','old','bigwin','bigwin','2026-08-01'),
        ('zeus','hidden','lasvegas','lasvegas','2026-09-01');
        INSERT INTO casino_transactions(id,platform,agente,username,tipo,monto,fecha) VALUES
          (20,'zeus','unknown-gap','gap','carga',99,'2026-08-20'),
          (21,'zeus','lasvegas','hidden','carga',999,'2026-09-01');`)
      for (const [platform,agent,from,to] of [
        ['consolidado',null,'2026-09-01','2026-09-30'],
        ['consolidado','royal','2026-09-01','2026-09-30'],
        ['bet30','zeusroyal','2026-09-01','2026-09-30'],
        ['consolidado',null,'2026-09-01','2026-09-15'],
        ['consolidado',null,'2026-11-01','2026-11-30'],
      ] as const) {
        const full=await casinoDashboard(platform,from,to,agent,run)
        const fast=await casinoAgentSummary(platform,from,to,agent,run)
        const normalize=(rows:typeof fast.sales_comparison.rows)=>rows.map(r=>({...r,amount:Number(r.amount),previous_amount:Number(r.previous_amount),difference:Number(r.difference)}))
        expect(normalize(fast.sales_comparison.rows)).toEqual(normalize(full.sales_comparison!.rows))
        expect(fast.sales_comparison.previous).toEqual(full.sales_comparison!.previous)
        const users=(rows:{agente:string,nuevos_mes:number}[])=>rows.map(({agente,nuevos_mes})=>({agente,nuevos_mes})).sort((a,b)=>a.agente.localeCompare(b.agente))
        expect(users(fast.agentes)).toEqual(users(full.agentes))
        const details=await casinoDashboard(platform,from,to,agent,run,false)
        const {sales_comparison,...remaining}=full
        expect(details).toEqual(remaining)
      }
    }finally{await db.query('ROLLBACK');await db.end()}
  })
})
