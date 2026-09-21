/**
 * Ganamos — capturar el endpoint real de las operaciones.
 *
 * Contexto: /user/{id}/payment/history/ sumado sobre los 80 nodos del árbol da
 * $100.100 en mayo 2026, contra $67.217.847 que muestra el panel. O el panel usa
 * otro endpoint, o esos totales son acumulados y no del período.
 *
 * PASOS
 *   1. Pegar esto en la consola de agents.ganamosnet.org.
 *   2. Ir a Reportes financieros -> Depositos/Retiros Jugadores.
 *   3. Poner un rango CORTO (un día), elegir agente, y tocar "Aplicar Filtro".
 *   4. Tocar "CARGAR OPERACIONES"  <-- esto es lo que falta capturar.
 *   5. Si aparece una tabla, pasar a la página 2.
 *   6. Ejecutar:  dumpOps()
 *
 * Ignora lo ya mapeado (notifications, tree, search) pero SÍ captura
 * payment/history, para ver si el panel lo llama con otros parámetros.
 */
(() => {
  if (window.__OPS_ON__) { console.warn("Ya activo. Ejecutá dumpOps()."); return; }
  window.__OPS_ON__ = true;
  const REG = window.__OPS__ = [];
  const firmas = new Set();

  const esRuido = u =>
    /\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map)(\?|$)/i.test(u) ||
    /google|gstatic|facebook|yandex|sentry|hotjar|analytics|socket\.io/i.test(u) ||
    /agent_admin\/(notifications|user\/search)/i.test(u) ||
    /agent_admin\/user\/\d+\/tree/i.test(u);

  const resumir = (txt) => {
    let j;
    try { j = JSON.parse(txt); } catch { return { forma: "no-json", muestra: String(txt).slice(0, 300) }; }
    const listas = [];
    const rec = (n, ruta = "", prof = 0) => {
      if (prof > 5 || !n || typeof n !== "object") return;
      if (Array.isArray(n)) {
        if (n.length && typeof n[0] === "object") listas.push({ ruta: ruta || "(raíz)", largo: n.length, campos: Object.keys(n[0]).join(", "), ej: n[0] });
        return;
      }
      for (const [k, v] of Object.entries(n)) rec(v, ruta ? `${ruta}.${k}` : k, prof + 1);
    };
    rec(j);
    // Cualquier número grande suelto puede ser un total monetario
    const numeros = {};
    const recNum = (n, ruta = "", prof = 0) => {
      if (prof > 4 || !n || typeof n !== "object" || Array.isArray(n)) return;
      for (const [k, v] of Object.entries(n)) {
        if (typeof v === "number" && Math.abs(v) > 1000) numeros[ruta ? `${ruta}.${k}` : k] = v;
        else if (typeof v === "object") recNum(v, ruta ? `${ruta}.${k}` : k, prof + 1);
      }
    };
    recNum(j);
    return {
      forma: Array.isArray(j) ? "(array)" : `objeto {${Object.keys(j ?? {}).join(", ")}}`,
      listas, numerosGrandes: numeros,
      status: j?.status, error: j?.error_message,
    };
  };

  const registrar = (e) => {
    const f = `${e.metodo} ${e.ruta} ${JSON.stringify(e.params)}`;
    if (firmas.has(f)) return;
    firmas.add(f);
    REG.push(e);
    const filas = e.resumen?.listas?.reduce((a, l) => a + l.largo, 0) ?? 0;
    console.log(`📡 [${REG.length}] ${e.metodo} ${e.ruta}  (${filas} filas)`);
  };

  const fo = window.fetch;
  window.fetch = async function (input, init = {}) {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    const res = await fo.apply(this, arguments);
    if (esRuido(url)) return res;
    try {
      const u = new URL(url, location.origin);
      const txt = await res.clone().text();
      registrar({
        metodo: (init.method ?? (typeof input === "object" ? input.method : null) ?? "GET").toUpperCase(),
        ruta: u.pathname, origen: u.origin,
        params: Object.fromEntries(u.searchParams.entries()),
        body: init.body ? String(init.body).slice(0, 800) : null,
        status: res.status,
        resumen: resumir(txt),
      });
    } catch { /* ignorar */ }
    return res;
  };

  const ao = XMLHttpRequest.prototype.open, so = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__o = { metodo: m, url: u }; return ao.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    const s = this.__o;
    if (s && !esRuido(s.url)) {
      this.addEventListener("load", () => {
        try {
          const u = new URL(s.url, location.origin);
          registrar({
            metodo: s.metodo.toUpperCase(), ruta: u.pathname, origen: u.origin,
            params: Object.fromEntries(u.searchParams.entries()),
            body: body ? String(body).slice(0, 800) : null,
            status: this.status, resumen: resumir(this.responseText),
          });
        } catch { /* ignorar */ }
      });
    }
    return so.apply(this, arguments);
  };

  window.dumpOps = () => {
    console.log("\n╔══════ ENDPOINTS DEL PANEL ══════╗");
    if (!REG.length) {
      console.warn("⚠️ Nada capturado. ¿Tocaste 'Aplicar Filtro' y 'Cargar Operaciones' DESPUÉS de pegar esto?");
      return;
    }
    for (const r of REG) {
      console.log(`\n▸ ${r.metodo} ${r.origen}${r.ruta}   [${r.status}]`);
      console.log("  params:", r.params);
      if (r.body) console.log("  body:", r.body);
      console.log("  forma:", r.resumen.forma, r.resumen.status !== undefined ? `| status:${r.resumen.status}` : "");
      if (Object.keys(r.resumen.numerosGrandes ?? {}).length) console.log("  💰 números grandes:", r.resumen.numerosGrandes);
      for (const l of r.resumen.listas ?? []) {
        console.log(`  📋 lista en "${l.ruta}": ${l.largo} filas`);
        console.log("     campos:", l.campos);
        console.log("     ejemplo:", l.ej);
      }
    }
    console.log("\n📋 Copiá todo. Busco: qué endpoint devuelve los $67.217.847 y con qué params.");
  };

  console.log(
    "✅ Listo. Ahora:\n" +
    "   1. Reportes financieros → Depositos/Retiros Jugadores\n" +
    "   2. Rango de UN día + agente → Aplicar Filtro\n" +
    "   3. ⚠️ Tocá 'CARGAR OPERACIONES' (es lo que falta)\n" +
    "   4. Si sale tabla, pasá a la página 2\n" +
    "   5. Ejecutá:  dumpOps()"
  );
})();
