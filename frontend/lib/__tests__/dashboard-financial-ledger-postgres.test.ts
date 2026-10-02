// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { Client } from 'pg'
import { overviewSql } from '../dashboard-overview'
import { depositAnalyticsSql, depositAnalytics } from '../dashboard-deposits'
import { formatProviderPesos } from '../dashboard-format'
describe.skipIf(process.env.RUN_DASHBOARD_PG_TESTS!=='1')('source reconciliation SQL',()=>{
 it('separates bonus operations, preserves original precision and scopes by platform', async()=>{
  const url=new URL(process.env.DATABASE_URL!);if(!['127.0.0.1','localhost'].includes(url.hostname))throw Error('Local only')
  const c=new Client({connectionString:url.toString()});await c.connect();
  try{await c.query('BEGIN');await c.query(`CREATE TEMP TABLE casino_transactions(id bigint,id_rec bigint,platform text,agente text,username text,tipo text,monto numeric,fecha date,fecha_hora_utc timestamptz,raw_detalles text) ON COMMIT DROP;
    CREATE TEMP TABLE casino_financial_source_records(platform text,source_id text,kind text,transaction_id bigint,agente text,username text,monto numeric,fecha date,fecha_hora_utc timestamptz) ON COMMIT DROP;
    INSERT INTO casino_transactions VALUES
    (1,1,'zeus','royal','p','carga',100,'2026-08-31','2026-09-01T02:59:59Z','Carga jugador'),
    (2,2,'zeus','royal','p','carga',20,'2026-08-31',NULL,'Bono'),
    (3,3,'argenbet','adminroyal','p','retiro',10.01,'2026-08-31',NULL,NULL),
    (4,4,'argenbet','adminroyal','p','retiro',10.01,'2026-08-31',NULL,NULL),
    (5,5,'zeus','royal','p','carga',999,'2026-09-01','2026-09-01T03:00:00Z','Carga jugador'),
    (6,6,'bet30','adminroyal','p','carga',999,'2026-08-31',NULL,'Carga jugador');
    INSERT INTO casino_financial_source_records VALUES
    ('bet30','b','bono',NULL,'zeusroyal','p',5,'2026-08-31',NULL),
    ('argenbet','a3','importe_original',3,'adminroyal','p',10.005,'2026-08-31',NULL),
    ('argenbet','a4','importe_original',4,'adminroyal','p',10.006,'2026-08-31',NULL);`)
   const rows=(await c.query(overviewSql('consolidado'),['2026-08-01','2026-08-31','royal'])).rows;
   const zeus=rows.find(r=>r.platform==='zeus'&&r.agente===null),bet=rows.find(r=>r.platform==='bet30'&&r.agente===null),arg=rows.find(r=>r.platform==='argenbet'&&r.agente===null);
   expect(Number(zeus.depositos)).toBe(100);expect(Number(zeus.bonos)).toBe(20);expect(Number(zeus.saldo_con_bonos)).toBe(120);
   expect(Number(bet.depositos)).toBe(0);expect(Number(bet.bonos)).toBe(5);
   expect(arg.retiros).toBe('20.011');expect(formatProviderPesos(arg.retiros,'argenbet')).toBe('$ 20,01');
   const graphs=depositAnalytics((await c.query(depositAnalyticsSql('consolidado'),['2026-08-01','2026-08-31','royal'])).rows,'consolidado');
   expect(graphs.total).toEqual({count:1,amount:'100'});expect(graphs.hours[23].count).toBe(1);
   expect(zeus.ultima_fecha).toBe('2026-09-01');
   const empty=(await c.query(overviewSql('consolidado'),['2025-01-01','2025-01-31','royal'])).rows;
   expect(empty.find(r=>r.platform==='zeus'&&r.agente===null)).toMatchObject({depositos:'0',retiros:'0',bonos:'0',movimientos:0,cuentas:0,ultima_fecha:'2026-09-01'});
   expect(empty.find(r=>r.platform==='bet30'&&r.agente==='zeusroyal')).toMatchObject({depositos:'0',bonos:'0',ultima_fecha:'2026-08-31'});
   // Timestamp dates take precedence even when the stored date disagrees; the
   // lower boundary is inclusive and the next Argentina midnight is exclusive.
   await c.query(`INSERT INTO casino_transactions VALUES
     (7,7,'zeus','royal','edge','carga',7,'1900-01-01','2026-08-01T03:00:00Z','Carga jugador'),
     (8,8,'zeus','royal','edge','carga',999,'2026-08-01','2026-08-01T02:59:59.999999Z','Carga jugador'),
     (9,9,'zeus',NULL,'shared','carga',3,'2026-08-01',NULL,'Carga jugador'),
     (10,10,'zeus','another','shared','carga',4,'2026-08-01',NULL,'Carga jugador');`);
   const bounded=(await c.query(overviewSql('consolidado'),['2026-08-01','2026-08-31','royal'])).rows;
   expect(bounded.find(r=>r.platform==='zeus'&&r.agente===null)).toMatchObject({depositos:'107',bonos:'20',movimientos:3,cuentas:2,ultima_fecha:'2026-09-01'});
   const boundedGraphs=depositAnalytics((await c.query(depositAnalyticsSql('consolidado'),['2026-08-01','2026-08-31','royal'])).rows,'consolidado');
   expect(boundedGraphs.total).toEqual({count:2,amount:'107'});
   expect(boundedGraphs.hours[0].amount).toBe('7');
   expect(boundedGraphs.hours[23].amount).toBe('100');
   const all=(await c.query(overviewSql('zeus'),['2026-08-01','2026-08-31',null])).rows;
   expect(all.find(r=>r.agente===null)).toMatchObject({depositos:'114',bonos:'20',movimientos:5,cuentas:3});
   expect(all.find(r=>r.agente==='Sin agente')).toMatchObject({depositos:'3',movimientos:1,cuentas:1});
  }finally{await c.query('ROLLBACK');await c.end()}
 })
})
