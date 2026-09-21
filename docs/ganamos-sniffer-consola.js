/**
 * Ganamos — reconocimiento v2 (agents.ganamosnet.org).
 *
 * Qué hace:
 *   a) Resuelve los agentUserId de los 6 agentes operativos usando el endpoint
 *      /api/agent_admin/user/search/ descubierto en la pasada anterior.
 *   b) Deja un sniffer activo que IGNORA lo ya conocido (notifications, tree,
 *      search) para que solo aparezca el endpoint de movimientos.
 *
 * Ya sabemos de la pasada 1:
 *   - Auth por COOKIE de sesión (ningún header authorization).
 *   - GET /api/agent_admin/user/search/?username=X&is_direct_structure=false
 *     → [{id, role, can_create_only_player, username}]
 *   - GET /api/agent_admin/user/{id}/tree/?username=  → [{id, username, child_count, level}]
 *   - admganamos = 23845278 · adminzeus = 23851856
 *
 * FALTA: el endpoint de Depositos/Retiros Jugadores.
 *
 * PASOS
 *   1. Pegar esto en la consola de agents.ganamosnet.org y Enter.
 *   2. Menú izquierdo → Reportes financieros → "Depositos/Retiros Jugadores".
 *   3. Elegir un agente (ej. adminzeus) y un rango CORTO → Aplicar Filtro.
 *   4. Pasar a la página 2 del resultado.
 *   5. Ejecutar en la consola:  dumpSniff()
 */
(async () => {
  const AGENTES = ["adminbtc", "adminzeus", "adminroyal", "admbigwin", "amdfarabet", "adminimperio"];

  // ── a) Resolver los IDs ────────────────────────────────────────────────────
  console.log("🔎 Resolviendo IDs de los 6 agentes…");
  const resueltos = [];
  for (const u of AGENTES) {
    try {
      const r = await fetch(
        `/api/agent_admin/user/search/?username=${encodeURIComponent(u)}&is_direct_structure=false`,
        { credentials: "include", headers: { accept: "application/json" } },
      );
      if (!r.ok) { resueltos.push({ username: u, id: `HTTP ${r.status}`, rol: "" }); continue; }
      const j = await r.json();
      const lista = Array.isArray(j) ? j : (j.items || j.results || j.data || []);
      const hit = lista.find(x => String(x.username).toLowerCase() === u.toLowerCase());
      resueltos.push(hit
        ? { username: u, id: String(hit.id), rol: String(hit.role ?? "") }
        : { username: u, id: "NO ENCONTRADO", rol: `${lista.length} parciales: ${lista.map(x => x.username).slice(0, 5).join(", ")}` });
    } catch (e) {
      resueltos.push({ username: u, id: "ERROR", rol: e.message });
    }
    await new Promise(r => setTimeout(r, 200));
  }
  console.table(resueltos);
  window.__AGENTES_GANAMOS__ = resueltos;

  // ── b) Sniffer, ignorando lo ya conocido ──────────────────────────────────
  if (window.__SNIFF_ON__) { console.warn("Sniffer ya activo — usá dumpSniff()."); return; }
  window.__SNIFF_ON__ = true;
  const REG = window.__SNIFF__ = [];
  const firmas = new Set();

  const enmascarar = v => {
    const s = String(v ?? "");
    return s.length < 24 ? s : `${s.slice(0, 12)}…[${s.length} chars]…${s.slice(-6)}`;
  };
  // Ruido: assets, terceros, y los endpoints que ya mapeamos
  const esRuido = u =>
    /\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map)(\?|$)/i.test(u) ||
    /google|gstatic|facebook|yandex|sentry|hotjar|analytics|socket\.io/i.test(u) ||
    /agent_admin\/(notifications|user\/search)/i.test(u) ||
    /agent_admin\/user\/\d+\/tree/i.test(u);

  const resumirCuerpo = (txt) => {
    let j;
    try { j = JSON.parse(txt); } catch { return { tipo: "no-json", muestra: String(txt).slice(0, 200) }; }
    const buscarLista = (n, prof = 0) => {
      if (prof > 4 || !n || typeof n !== "object") return null;
      if (Array.isArray(n)) return n.length ? n : null;
      for (const v of Object.values(n)) {
        if (Array.isArray(v) && v.length && typeof v[0] === "object") return v;
        const r = buscarLista(v, prof + 1);
        if (r) return r;
      }
      return null;
    };
    const lista = buscarLista(j);
    return {
      clavesRaiz: Array.isArray(j) ? "(array)" : Object.keys(j).join(", "),
      total: (j && !Array.isArray(j) && (j.total ?? j.count ?? j.totalCount ?? j.total_count ?? j.num_pages ?? j.pages)) ?? "—",
      items: lista ? lista.length : 0,
      campos: lista ? Object.keys(lista[0]).join(", ") : "—",
      primerItem: lista ? lista[0] : null,
      segundoItem: lista && lista[1] ? lista[1] : null,
    };
  };

  const registrar = (e) => {
    const f = `${e.metodo} ${e.ruta} ${JSON.stringify(e.params)}`;
    if (firmas.has(f)) return;      // no repetir llamadas idénticas
    firmas.add(f);
    REG.push(e);
    console.log(`📡 [${REG.length}] ${e.metodo} ${e.ruta}  (${e.respuesta?.items ?? 0} filas)`);
  };

  const fetchOrig = window.fetch;
  window.fetch = async function (input, init = {}) {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    const res = await fetchOrig.apply(this, arguments);
    if (esRuido(url)) return res;
    try {
      const u = new URL(url, location.origin);
      const hdrs = {};
      const h = init.headers ?? (typeof input === "object" ? input.headers : null);
      if (h) {
        const it = h instanceof Headers ? h.entries() : Object.entries(h);
        for (const [k, v] of it) if (/^(authorization|x-|token)/i.test(k)) hdrs[k] = enmascarar(v);
      }
      const txt = await res.clone().text();
      registrar({
        metodo: (init.method ?? (typeof input === "object" ? input.method : null) ?? "GET").toUpperCase(),
        ruta: u.pathname, origen: u.origin,
        params: Object.fromEntries(u.searchParams.entries()),
        headers: hdrs,
        body: init.body ? String(init.body).slice(0, 500) : null,
        status: res.status,
        respuesta: resumirCuerpo(txt),
      });
    } catch { /* nunca romper la app */ }
    return res;
  };

  const abrirOrig = XMLHttpRequest.prototype.open;
  const enviarOrig = XMLHttpRequest.prototype.send;
  const setHdrOrig = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u) { this.__s = { metodo: m, url: u, headers: {} }; return abrirOrig.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__s && /^(authorization|x-|token)/i.test(k)) this.__s.headers[k] = enmascarar(v);
    return setHdrOrig.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const s = this.__s;
    if (s && !esRuido(s.url)) {
      this.addEventListener("load", () => {
        try {
          const u = new URL(s.url, location.origin);
          registrar({
            metodo: s.metodo.toUpperCase(), ruta: u.pathname, origen: u.origin,
            params: Object.fromEntries(u.searchParams.entries()),
            headers: s.headers,
            body: body ? String(body).slice(0, 500) : null,
            status: this.status,
            respuesta: resumirCuerpo(this.responseText),
          });
        } catch { /* ignorar */ }
      });
    }
    return enviarOrig.apply(this, arguments);
  };

  window.dumpSniff = () => {
    console.log("\n╔══════ GANAMOS — MOVIMIENTOS ══════╗");
    console.log("IDs de agentes:");
    console.table(window.__AGENTES_GANAMOS__ ?? []);

    if (!REG.length) {
      console.warn(
        "⚠️ Ninguna llamada nueva capturada.\n" +
        "   ¿Entraste a Reportes financieros → Depositos/Retiros Jugadores y tocaste 'Aplicar Filtro'?\n" +
        "   (notifications / tree / search se ignoran a propósito: ya los conocemos)"
      );
      return;
    }
    console.log(`\n── ${REG.length} llamada(s) nueva(s) ──`);
    for (const r of REG) {
      console.log(`\n▸ ${r.metodo} ${r.origen}${r.ruta}   [${r.status}]`);
      console.log("  params:", r.params);
      if (Object.keys(r.headers).length) console.log("  headers:", r.headers);
      if (r.body) console.log("  body:", r.body);
      console.log("  claves raíz:", r.respuesta.clavesRaiz, "| total:", r.respuesta.total, "| filas:", r.respuesta.items);
      console.log("  campos del item:", r.respuesta.campos);
      console.log("  item 1:", r.respuesta.primerItem);
      if (r.respuesta.segundoItem) console.log("  item 2:", r.respuesta.segundoItem);
    }
    console.log("\n📋 Copiá todo esto.");
  };

  console.log(
    "\n✅ Sniffer activo (ignora notifications/tree/search).\n" +
    "   1. Reportes financieros → Depositos/Retiros Jugadores\n" +
    "   2. Elegí un agente + rango CORTO → Aplicar Filtro\n" +
    "   3. Pasá a la página 2\n" +
    "   4. Ejecutá:  dumpSniff()"
  );
})();
