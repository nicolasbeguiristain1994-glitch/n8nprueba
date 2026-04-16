#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

(function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!(k in process.env)) process.env[k] = v;
  }
})();

const RAILWAY_URL = process.env.N8N_RAILWAY_URL || 'https://zestful-learning-production-537c.up.railway.app';
const LOCAL_URL   = process.env.N8N_LOCAL_URL   || 'http://localhost:5678';

const TARGETS = [
  {
    file: './exports/WF-007-Send-WhatsApp-Message.json',
    instances: [
      { url: LOCAL_URL,   key: process.env.N8N_LOCAL_API_KEY,   id: 'vDgbsGuv29xLMhWG', pg: 'xEGqwiZXpd5tMF9C', http: 'V8WM8QJb690a2dcm', label: 'WF-007 local'   },
      { url: RAILWAY_URL, key: process.env.N8N_RAILWAY_API_KEY, id: 'dUscR5Yftpg3sHNO', pg: 'A01vYV0b0m0Uknex', http: 'z0qc54xuFOH2rrdz',  label: 'WF-007 railway' },
    ]
  },
  {
    file: './exports/WF-008-Webhook-Inbound-WhatsApp.json',
    instances: [
      { url: LOCAL_URL,   key: process.env.N8N_LOCAL_API_KEY,   id: 'LlD1vXL4gzegHwBE', pg: 'xEGqwiZXpd5tMF9C', http: 'V8WM8QJb690a2dcm', label: 'WF-008 local'   },
      { url: RAILWAY_URL, key: process.env.N8N_RAILWAY_API_KEY, id: 'CycYcDZjFLqo8oCg', pg: 'A01vYV0b0m0Uknex', http: 'z0qc54xuFOH2rrdz',  label: 'WF-008 railway' },
    ]
  },
];

async function deploy({ file, instances }) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));

  for (const inst of instances) {
    const wf = JSON.parse(JSON.stringify(raw)); // deep copy

    wf.nodes = wf.nodes.map(n => {
      if (n.type?.includes('postgres'))
        n.credentials = { postgres: { id: inst.pg, name: 'Postgres account' } };
      if (n.type?.includes('httpRequest') && (n.name?.includes('Evolution') || n.name?.includes('Typing')))
        n.credentials = { httpHeaderAuth: { id: inst.http, name: 'Header Auth account' } };
      if (n.parameters?.url?.includes('line-selector'))
        n.parameters.url = `${inst.url}/webhook/line-selector`;
      return n;
    });

    const body = {
      name: wf.name,
      nodes: wf.nodes,
      connections: wf.connections,
      settings: { executionOrder: wf.settings?.executionOrder ?? 'v1' },
    };

    const res  = await fetch(`${inst.url}/api/v1/workflows/${inst.id}`, {
      method: 'PUT',
      headers: { 'X-N8N-API-KEY': inst.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    console.log(`  ${data.id ? '✓' : '✗'} ${inst.label}: ${data.id ? 'ok' : data.message?.slice(0,80)}`);
  }
}

(async () => {
  for (const target of TARGETS) {
    console.log(`\n${target.file}`);
    await deploy(target);
  }
  console.log('\nDone.');
})();
