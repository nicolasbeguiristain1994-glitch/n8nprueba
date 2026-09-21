/**
 * Ganamos — totales diarios históricos (consola del navegador).
 *
 * Por qué existe: el detalle de transacciones (transfers_only=true) solo está
 * disponible para una ventana reciente (~60 días). Verificado el 2026-09-08:
 * "Cargar Operaciones" para el 01/03/2026 devuelve transfers:[] y total_count:0
 * en el panel mismo, mientras los totales de ese día muestran $265.000.
 * Los AGREGADOS sí están para todo el histórico (transfers_only=false).
 *
 * Este script recorre día por día con transfers_only=false y genera UN ARCHIVO
 * POR MES con la serie diaria de depósitos/retiros. No trae detalle por jugador
 * ni hora: para eso hace falta el detalle transaccional, que solo existe en la
 * ventana reciente (ver docs/ganamos-export-consola.js).
 *
 * ⚠️ Correr LOGUEADO CON LA CUENTA DEL AGENTE.
 */
(async () => {
  const IDS = {
    adminbtc: "23851783", adminzeus: "23851856", adminroyal: "24044323",
    admbigwin: "24045611", amdfarabet: "24050612", adminfara: "24050926",
    adminimperio: "34139043", admmega: "27622997",
  };

  const CFG = {
    agente: "adminfara",   // ← el agente con el que estás logueado
    agentId: null,
    desde: "2026-03-01",
    hasta: "2026-09-01",   // exclusivo
    pausaMs: 200,
  };

  const agente  = CFG.agente;
  const agentId = String(CFG.agentId ?? IDS[agente] ?? "");
  if (!agentId) return console.error(`❌ Sin id para "${agente}".`);

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const p2 = n => String(n).padStart(2, "0");
  const r2 = n => Math.round(n * 100) / 100;
  const fmtN = n => n.toLocaleString("es-AR", { minimumFractionDigits: 2 });
  const addDays = (iso, n) => { const [y,m,d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m-1, d+n)).toISOString().slice(0,10); };

  const pedir = async (desde, hasta) => {
    const p = new URLSearchParams({
      date_from: `${desde}T00:00:00`, date_to: `${hasta}T00:00:00`,
      username: "", role: "0",
      is_direct_structure: "false",
      is_higher_transaction_only: "false",
      is_withdrawal_transfers: "true",
      is_deposit_transfers: "true",
      page: "0", count: "10",
      is_bonus_deposits: "false",
      transfers_only: "false",      // ← agregados, disponibles para todo el histórico
    });
    const r = await fetch(`/api/agent_admin/user/${agentId}/payment/history/?${p}`,
      { credentials: "include", headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.status !== 0) throw new Error(`API ${j.status}: ${j.error_message ?? ""}`);
    return j;
  };

  // ── 1. Volcado de la respuesta cruda, para ver dónde están los totales ────
  console.log(`🔍 Respuesta cruda de ${CFG.desde} (para identificar los campos):`);
  let muestra;
  try { muestra = await pedir(CFG.desde, addDays(CFG.desde, 1)); }
  catch (e) { return console.error(`❌ ${e.message}`); }
  console.log(JSON.stringify(muestra, null, 2).slice(0, 2500));

  // Busca recursivamente números que parezcan totales de depósito/retiro
  const hallar = (nodo, patron, prof = 0) => {
    if (prof > 6 || !nodo || typeof nodo !== "object") return null;
    for (const [k, v] of Object.entries(nodo)) {
      if (typeof v === "number" && patron.test(k)) return { campo: k, valor: v };
      if (typeof v === "string" && patron.test(k) && !isNaN(parseFloat(v))) return { campo: k, valor: parseFloat(v) };
      if (v && typeof v === "object") { const r = hallar(v, patron, prof + 1); if (r) return r; }
    }
    return null;
  };
  const P_DEP = /deposit|ingres|carga|in_amount|^in$/i;
  const P_RET = /withdraw|retir|egres|out_amount|^out$/i;

  const d0 = hallar(muestra, P_DEP), r0 = hallar(muestra, P_RET);
  if (!d0 || !r0) {
    console.error(
      "❌ No pude identificar los campos de totales en la respuesta.\n" +
      "   Pegame el JSON de arriba y ajusto el script."
    );
    return;
  }
  console.log(`✅ Campos detectados → depósitos: "${d0.campo}" · retiros: "${r0.campo}"`);

  // ── 2. Serie diaria ───────────────────────────────────────────────────────
  const dias = [];
  for (let d = CFG.desde; d < CFG.hasta; d = addDays(d, 1)) dias.push(d);
  console.log(`\n📅 ${agente} (${agentId}) — ${dias.length} días. ~${Math.ceil(dias.length * (CFG.pausaMs + 350) / 60000)} min.`);

  const serie = [];
  let acumD = 0, acumR = 0, fallos = 0;

  for (const d of dias) {
    try {
      const j = await pedir(d, addDays(d, 1));
      const dep = hallar(j, P_DEP)?.valor ?? 0;
      const ret = hallar(j, P_RET)?.valor ?? 0;
      serie.push({ fecha: d, mes: d.slice(0, 7), depositos: r2(dep), retiros: r2(ret), neto: r2(dep - ret) });
      acumD += dep; acumR += ret;
      if (dep || ret) console.log(`   ${d}: dep $${fmtN(r2(dep))} · ret $${fmtN(r2(ret))}`);
    } catch (e) {
      fallos++;
      serie.push({ fecha: d, mes: d.slice(0, 7), depositos: "error", retiros: e.message, neto: "" });
      console.warn(`   ${d}: ${e.message}`);
    }
    await sleep(CFG.pausaMs);
  }

  // ── 3. Un archivo por mes ─────────────────────────────────────────────────
  if (!window.XLSX) {
    await new Promise((ok, err) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
      s.onload = ok; s.onerror = () => err(new Error("no XLSX"));
      document.head.appendChild(s);
    }).catch(() => console.warn("⚠️ XLSX no disponible."));
  }
  const dl = (blob, fn) => {
    const u = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: u, download: fn });
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(u);
  };

  // Todos los meses del rango, aunque alguno venga vacío
  const mesesRango = [];
  { let [y, m] = CFG.desde.split("-").map(Number);
    const [yF, mF] = CFG.hasta.split("-").map(Number);
    while (y < yF || (y === yF && m < mF)) { mesesRango.push(`${y}-${p2(m)}`); if (m === 12) { y++; m = 1; } else m++; } }

  const mensual = [];
  const hDia = ["fecha","depositos","retiros","neto"];

  for (const mes of mesesRango) {
    const delMes = serie.filter(s => s.mes === mes);
    let dep = 0, ret = 0, conMov = 0;
    for (const s of delMes) {
      if (typeof s.depositos !== "number") continue;
      dep += s.depositos; ret += s.retiros;
      if (s.depositos || s.retiros) conMov++;
    }
    const filasMes = delMes.map(({ mes: _m, ...r }) => r);
    filasMes.push({ fecha: "TOTAL", depositos: r2(dep), retiros: r2(ret), neto: r2(dep - ret) });

    mensual.push({ mes, depositos: r2(dep), retiros: r2(ret), neto: r2(dep - ret), diasConMovimiento: conMov });

    const base = `ganamos_TOTALES_${agente}_${mes}`;
    try {
      if (!window.XLSX) throw new Error("sin XLSX");
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(filasMes, { header: hDia });
      ws["!cols"] = [{wch:12},{wch:16},{wch:16},{wch:16}];
      ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s:{r:0,c:0}, e:{r:filasMes.length, c:hDia.length-1} }) };
      XLSX.utils.book_append_sheet(wb, ws, "Por día");
      dl(new Blob([XLSX.write(wb, { bookType: "xlsx", type: "array" })],
        { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${base}.xlsx`);
      console.log(`   💾 ${base}.xlsx — ${conMov} día(s) con movimiento · dep $${fmtN(r2(dep))}`);
    } catch {
      const csv = hDia.join(";") + "\n" + filasMes.map(r => hDia.map(h => String(r[h] ?? "")).join(";")).join("\n");
      dl(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" }), `${base}.csv`);
      console.warn(`   💾 ${base}.csv`);
    }
    await sleep(400);
  }

  mensual.push({
    mes: "TOTAL", depositos: r2(acumD), retiros: r2(acumR), neto: r2(acumD - acumR),
    diasConMovimiento: serie.filter(s => typeof s.depositos === "number" && (s.depositos || s.retiros)).length,
  });

  console.log(`\n═══ ${agente} — totales por mes ═══`);
  console.table(mensual);
  if (fallos) console.warn(`⚠️ ${fallos} día(s) con error.`);
  console.log(`✅ ${mesesRango.length} archivos generados, uno por mes.`);

  window.__GANAMOS_SERIE__ = serie;
  console.log("\n📊 Control: marzo debería dar $19.089.503 en depósitos y $6.854.240,27 en retiros.");
})();
