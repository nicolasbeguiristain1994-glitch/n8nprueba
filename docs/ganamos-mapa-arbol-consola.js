/**
 * Ganamos — mapa del árbol y dónde está la actividad (v2). No descarga archivos.
 *
 * Problema: /user/{id}/payment/history/ sobre adminzeus o adminroyal devuelve 2-3
 * movimientos en mayo 2026, mientras el panel muestra $67.217.847 en depósitos.
 * Hipótesis: el endpoint devuelve solo las transferencias propias del agente y la
 * plata cuelga de nodos descendientes.
 *
 * La API se consulta SIEMPRE en ventanas de 24 h (confirmado por el operador: los
 * agentes tienen mucho movimiento y rangos más largos no son confiables).
 * Estrategia en dos fases para no hacer miles de requests:
 *   Fase A — sondeo barato: 3 días sueltos sobre TODOS los nodos del árbol.
 *   Fase B — a los nodos con actividad, se les mide el mes COMPLETO día por día.
 */
(async () => {
  const RAIZ  = { id: "23845278", username: "admganamos" };
  const MES   = { desde: "2026-05-01", hasta: "2026-06-01", etiqueta: "mayo 2026" };
  const SONDEO = ["2026-05-05", "2026-05-15", "2026-05-26"];   // 26/05 tuvo actividad confirmada
  const PANEL = { depositos: 67217847, retiros: 44504049.74 }; // ajustar si el total del panel era de otro agente
  const MAX_NODOS = 80, MAX_PROF = 4;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const fmt = n => n.toLocaleString("es-AR", { minimumFractionDigits: 2 });
  const r2  = n => Math.round(n * 100) / 100;
  const addDays = (iso, n) => { const [y,m,d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m-1, d+n)).toISOString().slice(0,10); };

  const cosechar = (n, out = [], visto = new Set()) => {
    if (!n || typeof n !== "object") return out;
    if (Array.isArray(n)) { for (const x of n) cosechar(x, out, visto); return out; }
    const u = n.username ?? n.userName, i = n.id ?? n.userId;
    if (typeof u === "string" && u && i != null && !visto.has(String(i))) {
      visto.add(String(i));
      out.push({ id: String(i), username: u, childCount: n.child_count ?? null });
    }
    for (const v of Object.values(n)) cosechar(v, out, visto);
    return out;
  };

  const base = {
    username: "", role: "0",
    is_direct_structure: "false",
    is_higher_transaction_only: "false",
    is_withdrawal_transfers: "true",
    is_deposit_transfers: "true",
    is_bonus_deposits: "false",
    transfers_only: "true",
  };

  // Trae un rango (paginando) y devuelve las filas
  const traer = async (id, desde, hasta) => {
    const out = [];
    for (let page = 0; page < 40; page++) {
      const p = new URLSearchParams({ ...base,
        date_from: `${desde}T00:00:00`, date_to: `${hasta}T00:00:00`,
        page: String(page), count: "500" });
      const r = await fetch(`/api/agent_admin/user/${id}/payment/history/?${p}`,
        { credentials: "include", headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.status !== 0) throw new Error(`API ${j.status}`);
      const arr = j.result?.transfers ?? [];
      out.push(...arr);
      if (arr.length < 500) break;
      await sleep(120);
    }
    return out;
  };

  const totalizar = (filas) => {
    let dep = 0, ret = 0;
    for (const t of filas) { const m = Number(t.amount) || 0; if (t.operation === 0) dep += m; else ret += m; }
    return { movs: filas.length, dep: r2(dep), ret: r2(ret) };
  };

  // ── 1. Árbol ──────────────────────────────────────────────────────────────
  console.log(`🌳 Recorriendo el árbol desde ${RAIZ.username} (${RAIZ.id})…`);
  const nodos = new Map([[RAIZ.id, { ...RAIZ, prof: 0, padre: "—" }]]);
  let frontera = [RAIZ];

  for (let prof = 1; prof <= MAX_PROF && frontera.length && nodos.size < MAX_NODOS; prof++) {
    const siguiente = [];
    for (const padre of frontera) {
      try {
        const r = await fetch(`/api/agent_admin/user/${padre.id}/tree/?username=`,
          { credentials: "include", headers: { accept: "application/json" } });
        if (r.ok) {
          for (const h of cosechar(await r.json())) {
            if (h.id === padre.id || nodos.has(h.id)) continue;
            nodos.set(h.id, { ...h, prof, padre: padre.username });
            if (h.childCount === null || h.childCount > 0) siguiente.push(h);
            if (nodos.size >= MAX_NODOS) break;
          }
        }
      } catch { /* seguir */ }
      await sleep(150);
      if (nodos.size >= MAX_NODOS) break;
    }
    frontera = siguiente;
    console.log(`   nivel ${prof}: ${nodos.size} nodos acumulados`);
  }
  console.log(`🌳 ${nodos.size} nodos.`);

  // ── 2. Fase A: sondeo de 3 días sueltos sobre todos los nodos ─────────────
  console.log(`\n🔬 Fase A — sondeo de ${SONDEO.length} días (${SONDEO.join(", ")}) en ${nodos.size} nodos…`);
  const activos = [];
  const sondeoFilas = [];

  for (const n of nodos.values()) {
    let movs = 0, dep = 0, err = null;
    for (const dia of SONDEO) {
      try {
        const t = totalizar(await traer(n.id, dia, addDays(dia, 1)));
        movs += t.movs; dep += t.dep;
      } catch (e) { err = e.message; break; }
      await sleep(120);
    }
    sondeoFilas.push({ agente: n.username, id: n.id, nivel: n.prof, padre: n.padre, movs3dias: err ?? movs, dep3dias: r2(dep) });
    if (!err && movs > 0) { activos.push(n); console.log(`   ✔ ${n.username}: ${movs} movs en 3 días`); }
  }
  sondeoFilas.sort((a, b) => (Number(b.movs3dias) || 0) - (Number(a.movs3dias) || 0));
  console.log("\n═══ FASE A — actividad en los 3 días de muestra ═══");
  console.table(sondeoFilas);

  if (!activos.length) {
    console.warn("⚠️ Ningún nodo con movimientos en los días de muestra. Probá otros días en SONDEO.");
    return;
  }

  // ── 3. Fase B: mes completo día por día en los nodos activos ──────────────
  console.log(`\n📊 Fase B — mes completo, día por día, en ${activos.length} nodo(s) activo(s)…`);
  const filas = [];
  let totalMovs = 0, totalDep = 0, totalRet = 0;

  for (const n of activos) {
    const vistos = new Set(); const acum = [];
    let fallo = null;
    for (let d = MES.desde; d < MES.hasta; d = addDays(d, 1)) {
      try {
        for (const t of await traer(n.id, d, addDays(d, 1))) {
          if (!vistos.has(t.id)) { vistos.add(t.id); acum.push(t); }
        }
      } catch (e) { fallo = e.message; break; }
      await sleep(110);
    }
    const porDia = totalizar(acum);

    filas.push({
      agente: n.username, id: n.id, nivel: n.prof, padre: n.padre,
      movimientos: fallo ?? porDia.movs,
      depositos: porDia.dep, retiros: porDia.ret,
      jugadores: new Set(acum.map(t => t.from_user === n.username ? t.to_user : t.from_user)).size,
    });
    if (!fallo) { totalMovs += porDia.movs; totalDep += porDia.dep; totalRet += porDia.ret; }
    console.log(`   ${n.username}: ${porDia.movs} movs · dep $${fmt(porDia.dep)}`);
    await sleep(200);
  }

  filas.sort((a, b) => (Number(b.depositos) || 0) - (Number(a.depositos) || 0));
  console.log(`\n═══ FASE B — ${MES.etiqueta} por nodo ═══`);
  console.table(filas);

  console.log(`\n═══ COMPARACIÓN CONTRA EL PANEL ═══`);
  console.log(`Suma de nodos activos : ${totalMovs} movs · dep $${fmt(r2(totalDep))} · ret $${fmt(r2(totalRet))}`);
  console.log(`Panel                 : dep $${fmt(PANEL.depositos)} · ret $${fmt(PANEL.retiros)}`);
  const falta = r2(PANEL.depositos - totalDep);
  console.log(Math.abs(falta) < 1
    ? "✅ CIERRAN — sumando nodo por nodo se reconstruye el total del panel."
    : `⚠️ FALTAN $${fmt(falta)} en depósitos (${r2(totalDep / PANEL.depositos * 100)}% capturado).`);

  window.__GANAMOS_ARBOL__ = { sondeo: sondeoFilas, mes: filas };
  console.log("\n📋 Copiá las dos tablas y la comparación. (También en window.__GANAMOS_ARBOL__)");
})();
