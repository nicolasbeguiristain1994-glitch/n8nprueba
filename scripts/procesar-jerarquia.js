/**
 * Aplana el árbol de jerarquía de Zeus Casino
 * Input:  exports/zeus_api_raw.json (ya capturado)
 * Output: exports/zeus_usuarios_map.json  → { id: username }
 *         exports/zeus_usuarios.csv       → id, username, jerarquia, habilitado
 */

const fs = require('fs');
const path = require('path');

const RAW_PATH = path.join(__dirname, '../exports/zeus_api_raw.json');
const OUT_DIR  = path.join(__dirname, '../exports');

const raw = JSON.parse(fs.readFileSync(RAW_PATH, 'utf8'));

// Buscar el endpoint de jerarquía
const jerarquiaKey = Object.keys(raw).find(k => k.includes('new_jerarquia'));
if (!jerarquiaKey) {
  console.error('❌ No se encontró el endpoint new_jerarquia en zeus_api_raw.json');
  process.exit(1);
}

const jerarquiaData = raw[jerarquiaKey];
const raiz = jerarquiaData?.data?.[0] || jerarquiaData?.[0] || jerarquiaData;

console.log(`✅ Árbol encontrado. Raíz: ${raiz.name} (id: ${raiz.id})`);

// Aplanar el árbol recursivamente
function aplanar(nodo, resultado = []) {
  if (!nodo) return resultado;
  resultado.push({
    id:         nodo.id,
    username:   nodo.name,
    jerarquia:  nodo.jerarquia,
    habilitado: nodo.enabled,
    nivel:      (nodo.jerarquia || '').split('.').length,
  });
  if (Array.isArray(nodo.hijos)) {
    nodo.hijos.forEach(hijo => aplanar(hijo, resultado));
  }
  return resultado;
}

const todos = aplanar(raiz);
console.log(`📋 Total usuarios en árbol: ${todos.length}`);

// Separar agentes de posibles jugadores
// Los jugadores suelen estar en hojas (sin hijos) o en los niveles más profundos
const niveles = [...new Set(todos.map(u => u.nivel))].sort((a, b) => a - b);
console.log(`   Niveles detectados: ${niveles.join(', ')}`);
console.log(`   Nivel máximo: ${Math.max(...niveles)}`);

// Contar por nivel
niveles.forEach(n => {
  const count = todos.filter(u => u.nivel === n).length;
  console.log(`   Nivel ${n}: ${count} usuarios`);
});

// Crear mapa id → username
const mapaId = {};
todos.forEach(u => { mapaId[u.id] = u.username; });

// Guardar mapa
const mapPath = path.join(OUT_DIR, 'zeus_usuarios_map.json');
fs.writeFileSync(mapPath, JSON.stringify(mapaId, null, 2));
console.log(`\n💾 Mapa ID→username: ${mapPath} (${Object.keys(mapaId).length} entradas)`);

// Guardar CSV completo
const csvPath = path.join(OUT_DIR, 'zeus_usuarios.csv');
const headers = ['id', 'username', 'jerarquia', 'habilitado', 'nivel'];
const csvRows = [
  headers.join(','),
  ...todos.map(u => headers.map(h => `"${String(u[h] ?? '').replace(/"/g, '""')}"`).join(','))
];
fs.writeFileSync(csvPath, csvRows.join('\n'), 'utf8');
console.log(`💾 CSV: ${csvPath}`);

// Mostrar algunos ejemplos de usuarios en nivel máximo (probablemente jugadores)
const nivelMax = Math.max(...niveles);
const hojasEjemplo = todos.filter(u => u.nivel === nivelMax).slice(0, 5);
console.log(`\n📌 Ejemplos nivel ${nivelMax} (probables jugadores):`);
hojasEjemplo.forEach(u => console.log(`   id=${u.id} username=${u.username}`));
