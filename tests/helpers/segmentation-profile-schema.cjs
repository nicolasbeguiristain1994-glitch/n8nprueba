const fs=require('node:fs'),path=require('node:path');
exports.install=async function(client,schema,root=path.resolve(__dirname,'../..')) {
  await client.query(`CREATE TABLE IF NOT EXISTS contact_lists(id uuid PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS campaigns(id uuid PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS segmentation_tiers(tier text,workspace_id text DEFAULT 'default',deposit_threshold_min int,updated_at timestamptz);
    INSERT INTO segmentation_tiers(tier,deposit_threshold_min) VALUES ('bajo',0),('medio',100000),('vip',500000),('vip_medio',1000000),('vip_alto',1500000),('super_vip',3200000);
    CREATE TABLE IF NOT EXISTS casino_sync_runs(platform text,status text,finished_at timestamptz);
    CREATE TABLE IF NOT EXISTS casino_financial_source_records(transaction_id bigint,platform text,kind text,monto numeric);
    CREATE TABLE IF NOT EXISTS casino_dashboard_account_totals(platform text,username_lower text,agente text,first_deposit_agent text,total_cargas numeric,total_retiros numeric,cant_cargas int,cant_retiros int,fecha_primera date,fecha_ultima date,meses_activos int,movimientos int);`);
  await client.query(fs.readFileSync(path.join(root,'db/migrations/143_contact_segmentation_profiles.sql'),'utf8').replace(/\bpublic\b/g,schema));
};
