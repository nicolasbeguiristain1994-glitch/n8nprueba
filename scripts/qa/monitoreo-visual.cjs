// Visual QA only: fixed loopback origin, synthetic session, mocked API, no DB.
// Start frontend with AUTH_SECRET=monitoring-local-fixture-secret and port 4017.
// Optional MONITORING_PLAYWRIGHT_MODULE: absolute path to an isolated Playwright install.
const {chromium}=require(process.env.MONITORING_PLAYWRIGHT_MODULE || 'playwright');
const {createHmac}=require('crypto');
const assert=require('node:assert/strict');
const now=new Date().toISOString();
const user={user_id:'synthetic-admin',id:'synthetic-admin',email:'local@example.test',name:'Prueba local',role:'admin',sectors:['dashboard','audit'],session_version:1,can_download_contacts:false,allowed_agents:[],is_super_admin:false,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,nonce:'local'};
const payload=Buffer.from(JSON.stringify(user)).toString('base64url');
const token=payload+'.'+createHmac('sha256','monitoring-local-fixture-secret').update(payload).digest('base64url');
const run={run_id:'11111111-1111-4111-8111-111111111111',platform:'zeus',mode:'auto',triggered_by:'cli',requested_desde:null,requested_hasta:null,status:'partial',started_at:now,heartbeat_at:now,finished_at:now,agents_total:5,agents_ok:4,agents_failed:1,ranges_ok:4,ranges_failed:1,ranges_skipped:0,tx_fetched:100,tx_inserted:80,tx_without_id:0,players_recomputed:20,error_code:'AGENT_FAILURES',error_message:'Falla sintética',segmentation_status:'skipped',segmentation_finished_at:now,is_stale:false};
const data={generated_at:now,today_ar:'2026-09-13',stale_after_minutes:10,observed_window_days:60,runs:{items:[run],total:1,limit:20,offset:0},latest_by_platform:[run],coverage:[{platform:'zeus',agente:'betcoin',covered_from:'2026-09-01',covered_through:'2026-09-12',cursor_updated_at:now,last_status:'success',last_desde:'2026-09-12',last_hasta:'2026-09-13',last_error_code:null,last_error_message:null,last_finished_at:now,last_success_at:now,limited_ranges:0,collapsed_without_id:0,observed_from:'2026-09-01',observed_through:'2026-09-13',last_movement_at:now,observed_tx:100}],unclassified_legacy:[{agente:'bigwin',filas:125,desde:'2026-06-01',hasta:'2026-09-01'}],alerts:[{id:'failure',severity:'critical',type:'classification_required',platform:'zeus',agente:'bigwin',message:'Bigwin tiene filas históricas sin plataforma. Revisar su clasificación antes de sincronizar.',since:now}]};
const {mkdirSync,writeFileSync}=require('node:fs');
const out='/private/tmp/wa-monitoring-visual';mkdirSync(out,{recursive:true});
const longAgent='agente_abcdefghijklmnopqrstuvwxyz_0123456789_local';
const failed={...run,status:'failed',agents_ok:0,agents_failed:5,error_code:'PROVIDER_UNAVAILABLE'};
const skipped={...run,run_id:'22222222-2222-4222-8222-222222222222',status:'skipped',error_code:'PLATFORM_BUSY'};
const interrupted={...run,run_id:'33333333-3333-4333-8333-333333333333',platform:'bet30',status:'running',is_stale:true,finished_at:null,segmentation_status:'pending',error_code:null};
const success={...run,run_id:'44444444-4444-4444-8444-444444444444',status:'success',agents_ok:5,agents_failed:0,error_code:null,segmentation_status:'success'};
data.latest_by_platform=[failed,interrupted];data.latest_attempt_by_platform=[skipped,interrupted];
const allRuns=Array.from({length:21},(_,i)=>({...([skipped,failed,interrupted,run,success][i%5]),run_id:`55555555-5555-4555-8555-${String(i+1).padStart(12,'0')}`}));
data.runs={items:allRuns.slice(0,20),total:21,limit:20,offset:0};
data.coverage.push({...data.coverage[0],agente:'royal',limited_ranges:2,collapsed_without_id:4,invalid_rows:1,last_status:'failed',last_error_code:'PROVIDER_UNAVAILABLE',last_attempt_status:'skipped',last_attempt_error_code:'PLATFORM_BUSY'}, {...data.coverage[0],platform:'bet30',agente:'btcuno',configured:true,covered_from:null,covered_through:null,cursor_updated_at:null,last_status:null,last_desde:null,last_hasta:null,last_success_at:null,observed_from:null,observed_through:null,observed_tx:0,last_movement_at:null});
data.alerts.push({id:'limited',severity:'warning',type:'coverage_limited',platform:'zeus',agente:longAgent,message:`Cobertura limitada para ${longAgent}: se detectaron movimientos sin ID y filas no interpretables.`,since:now},{id:'never',severity:'info',type:'never_synced',platform:'bet30',agente:'btcuno',message:'btcuno está configurado y todavía no tiene una corrida registrada.',since:null});
(async()=>{
 const browser=await chromium.launch({headless:true,chromiumSandbox:true});
 const report={screenshots:[],geometry:[],checks:[],pageErrors:[],consoleErrors:[],blockedExternal:[],apiRequests:[]};
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1100},colorScheme:'light',locale:'es-AR',timezoneId:'America/Argentina/Buenos_Aires',serviceWorkers:'block'});
  await context.addCookies([{name:'session',value:token,url:'http://127.0.0.1:4017'}]);
  const page=await context.newPage();page.setDefaultTimeout(15000);
  page.on('pageerror',e=>report.pageErrors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')report.consoleErrors.push(m.text())});
  let scenario='rich',requests=0;
  await context.route('**/*',route=>{
   const url=new URL(route.request().url());
   if(url.origin!=='http://127.0.0.1:4017'){report.blockedExternal.push(url.origin);return route.abort();}
   if(!url.pathname.startsWith('/api/'))return route.continue();
   report.apiRequests.push({path:url.pathname,method:route.request().method()});
   let body={},status=200;
   if(url.pathname==='/api/auth/me')body={user,permissions:{audit:['read'],dashboard:['read']}};
   else if(url.pathname==='/api/monitoring/casino-sync'){
    requests++;
    if(scenario==='network')return route.abort('failed');
    const offset=Number(url.searchParams.get('offset')||0);
    body={...data,runs:{...data.runs,items:allRuns.slice(offset,offset+20),offset}};
    if(scenario==='empty')body={...data,runs:{items:[],total:0,limit:20,offset:0},latest_by_platform:[],latest_attempt_by_platform:[],coverage:[],unclassified_legacy:[],alerts:[]};
    if(scenario==='403'){status=403;body={error:'Forbidden'};}
   }else body={items:[],data:[],count:0,unread:0};
   return route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  async function capture(name){const path=`${out}/${name}.png`;await page.screenshot({path,fullPage:true});report.screenshots.push(path);}
  async function top(){await page.locator('main').evaluate(e=>{e.scrollTop=0;e.scrollLeft=0});}
  async function section(title){const target=page.getByText(title,{exact:true});await target.evaluate(e=>e.scrollIntoView({block:'start'}));}
  async function refresh(){const previous=requests;await page.getByRole('button',{name:'Actualizar',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('button[disabled] svg.animate-spin'));assert.ok(requests>previous);}
  const navigation=await page.goto('http://127.0.0.1:4017/monitoreo',{waitUntil:'domcontentloaded'});
  const csp=navigation.headers()['content-security-policy'];const scriptPolicy=csp.split(';').find(s=>s.trim().startsWith('script-src'));assert.ok(!scriptPolicy.includes('unsafe-eval')&&!scriptPolicy.includes('unsafe-inline'));
  const nonce=csp.match(/'nonce-([^']+)'/)[1];
  report.nonceCheck=await page.evaluate(n=>{const scripts=[...document.querySelectorAll('script:not([src])')].filter(s=>s.textContent.trim());return {inlineScripts:scripts.length,allMatch:scripts.every(s=>s.nonce===n)};},nonce);
  assert.ok(report.nonceCheck.inlineScripts>0&&report.nonceCheck.allMatch);report.checks.push('CSP intact; Next inline scripts and theme script have matching nonce');
  await page.getByRole('heading',{name:'Centro de Monitoreo'}).waitFor();
  try{await page.getByText('Bigwin tiene filas históricas',{exact:false}).waitFor();}catch(e){await capture('debug-loading');writeFileSync(`${out}/debug-text.txt`,await page.locator('body').innerText());throw e;}
  await page.getByRole('checkbox',{name:'Auto (60 s)'}).uncheck();
  await page.getByText('Configurado, sin sincronizar',{exact:true}).waitFor({state:'attached'});
  await page.getByText('Certeza limitada',{exact:true}).waitFor({state:'attached'});
  await page.getByText('Último intento: omitido',{exact:false}).waitFor({state:'attached'});
  report.checks.push('rich fixture: failure retained after skipped attempt, stale run, limited/never synced coverage, three alert severities');
  for(const size of [{name:'desktop',width:1440,height:1100},{name:'mobile',width:390,height:844},{name:'mobile-small',width:320,height:740}]){
   await page.setViewportSize({width:size.width,height:size.height});await top();await page.evaluate(()=>document.fonts.ready);
   await capture(`${size.name}-overview`);
   report.geometry.push(await page.evaluate(name=>{
    const main=document.querySelector('main');
    const alerts=[...document.querySelectorAll('[data-slot="card-content"] .min-w-0')].map(e=>({width:e.clientWidth,scrollWidth:e.scrollWidth}));
    return {name,viewport:innerWidth,document:document.documentElement.scrollWidth,main:{width:main.clientWidth,scrollWidth:main.scrollWidth},alerts,tables:[...document.querySelectorAll('[data-slot="table-container"]')].map(e=>({width:e.clientWidth,scrollWidth:e.scrollWidth}))};
   },size.name));
   await section('Rango procesado por plataforma y agente');await capture(`${size.name}-coverage`);
   const table=page.locator('[data-slot="table-container"]').first();
   await table.evaluate(e=>{e.scrollLeft=e.scrollWidth});assert.ok(await table.evaluate(e=>e.scrollWidth<=e.clientWidth||e.scrollLeft>0));
   await capture(`${size.name}-coverage-right`);await table.evaluate(e=>{e.scrollLeft=0});
   await section('Corridas (21)');await capture(`${size.name}-runs`);
   await section('Filas históricas sin plataforma');await capture(`${size.name}-legacy`);
  }
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Siguiente',exact:true}).click();await page.getByText('21–21 de 21',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Siguiente',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Anterior',exact:true}).click();await page.getByText('1–20 de 21',{exact:true}).waitFor();report.checks.push('pagination next/previous');
  await refresh();report.checks.push('manual refresh');
  scenario='empty';await refresh();await page.getByText('Sin corridas.',{exact:true}).waitFor();await top();await capture('mobile-empty');report.checks.push('empty state');
  scenario='403';await refresh();await page.getByText('Solo los administradores pueden ver el Centro de Monitoreo.').waitFor();assert.equal(await page.locator('table').count(),0);await top();await capture('mobile-forbidden');report.checks.push('403 hides data');
  scenario='network';await refresh();await page.getByText('Error de red al consultar el estado del sync.').waitFor();await capture('mobile-network-error');
  scenario='rich';await refresh();await page.getByText('Bigwin tiene filas históricas',{exact:false}).waitFor();report.checks.push('network failure and retry');
  assert.equal(report.apiRequests.some(r=>r.method!=='GET'),false);assert.equal(report.pageErrors.length,0,JSON.stringify(report.pageErrors));
  const overflow=report.geometry.filter(g=>g.document>g.viewport||g.main.scrollWidth>g.main.width+1||g.alerts.some(a=>a.scrollWidth>a.width+1));
  report.checks.push('no live API calls or writes, no uncaught JavaScript errors');report.overflow=overflow;
  console.log(JSON.stringify({screenshots:report.screenshots.length,checks:report.checks,geometry:report.geometry,overflow,consoleErrors:report.consoleErrors.length},null,2));
  if(overflow.length)process.exitCode=2;
 }catch(e){report.error=e.stack;console.error(e.stack);process.exitCode=1;}
 finally{writeFileSync(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();}
})();
