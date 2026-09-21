/**
 * Ganamos — exportador de movimientos (consola del navegador).
 *
 * ⚠️ HAY QUE ESTAR LOGUEADO CON LA CUENTA DEL AGENTE QUE SE QUIERE EXPORTAR.
 * Desde la sesión del administrador el endpoint devuelve solo un puñado de
 * movimientos por subordinado (medido: 80 nodos sumaban $100.100 en mayo 2026
 * contra $67.217.847 del panel). Desde la sesión del agente devuelve todo.
 *
 * Genera UN ARCHIVO POR MES, con 3 hojas: Jugadores · Movimientos · Por hora.
 * Se genera el archivo de TODOS los meses del rango, incluidos los que no tienen
 * movimientos (salen con total en cero) — así la serie queda completa y sin huecos,
 * y los períodos son comparables entre agentes.
 *
 * Cada mes se recorre día por día: la API no es confiable con ventanas > 24 h.
 *
 * API: GET /api/agent_admin/user/{agentId}/payment/history/
 *   cookie de sesión · date_from/date_to · page/count (500) · operation 0 = depósito
 */
(async () => {
  const IDS = {
    adminbtc:     "23851783",
    adminzeus:    "23851856",
    adminroyal:   "24044323",
    admbigwin:    "24045611",
    amdfarabet:   "24050612",   // ojo: "amd", distinto de adminfara
    adminfara:    "24050926",   // usuario distinto de amdfarabet
    adminimperio: "34139043",
    admmega:      "27622997",
  };

  const CFG = {
    agente:  "adminfara",  // ← EL AGENTE CON EL QUE ESTÁS LOGUEADO AHORA
    agentId: null,         // null = se toma de IDS

    desde: "2026-03-01",   // inclusive
    hasta: "2026-09-01",   // EXCLUSIVE — se baja hasta el 31/08

    count: 500,
    pausaMs: 250,
    maxPaginas: 200,
    verificarSesion: true,
  };

  const agente  = CFG.agente;
  const agentId = String(CFG.agentId ?? IDS[agente] ?? "");
  if (!agentId) return console.error(`❌ Sin id para "${agente}". Agregalo en IDS o poné CFG.agentId.`);

  const BASE  = `/api/agent_admin/user/${agentId}/payment/history/`;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const p2    = n => String(n).padStart(2, "0");
  const r2    = n => Math.round(n * 100) / 100;
  const fmtN  = n => n.toLocaleString("es-AR", { minimumFractionDigits: 2 });

  const addDays = (iso, n) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  };
  const aMs = c => {                                   // created_at viene sin zona y es UTC
    if (!c) return 0;
    const s = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(c) ? c : `${c}Z`;
    const t = new Date(s).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  const arg     = ms => new Date(ms - 3 * 3600000);    // UTC-3 sin DST
  const fechaDe = ms => { const d = arg(ms); return `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`; };
  const horaDe  = ms => { const d = arg(ms); return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`; };
  const hourOf  = ms => arg(ms).getUTCHours();
  const mesDe   = ms => { const d = arg(ms); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}`; };

  const fetchDia = async (dia, intento = 0) => {
    const salida = [];
    for (let page = 0; page < CFG.maxPaginas; page++) {
      const p = new URLSearchParams({
        date_from: `${dia}T00:00:00`,
        date_to:   `${addDays(dia, 1)}T00:00:00`,
        username: "", role: "0",
        is_direct_structure: "false",
        is_higher_transaction_only: "false",
        is_withdrawal_transfers: "true",
        is_deposit_transfers: "true",
        page: String(page), count: String(CFG.count),
        is_bonus_deposits: "false",
        transfers_only: "true",    // true = devuelve las filas en result.transfers.
                                   // false = devuelve los TOTALES del período, sin filas.
      });
      const res = await fetch(`${BASE}?${p}`, { credentials: "include", headers: { accept: "application/json" } });

      if (res.status === 401 || res.status === 403) {
        if (intento >= 3) throw new Error(`Sesión caída (HTTP ${res.status}) en ${dia}`);
        console.warn(`🔑 HTTP ${res.status} — sesión vencida. Recargá OTRA pestaña del panel; reintento en 30 s.`);
        await sleep(30000);
        return fetchDia(dia, intento + 1);
      }
      if (res.status === 429) { await sleep(5000); return fetchDia(dia, intento); }
      if (!res.ok) {
        if (intento >= 3) throw new Error(`HTTP ${res.status} en ${dia}`);
        await sleep(1000 * 2 ** intento);
        return fetchDia(dia, intento + 1);
      }
      const json = await res.json();
      if (json.status !== 0) throw new Error(`API ${dia}: ${json.error_message ?? json.status}`);
      const arr = json.result?.transfers ?? [];
      salida.push(...arr);
      if (arr.length < CFG.count) break;
      await sleep(CFG.pausaMs);
    }
    return salida;
  };

  // ── Meses del rango ───────────────────────────────────────────────────────
  const meses = [];
  {
    let [y, m] = CFG.desde.split("-").map(Number);
    const [yF, mF] = CFG.hasta.split("-").map(Number);
    while (y < yF || (y === yF && m < mF)) {
      const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
      meses.push({ desde: `${y}-${p2(m)}-01`, hasta: `${ny}-${p2(nm)}-01`, etiqueta: `${y}-${p2(m)}` });
      y = ny; m = nm;
    }
  }
  let diasTotales = 0;
  for (const mes of meses) for (let d = mes.desde; d < mes.hasta; d = addDays(d, 1)) diasTotales++;

  console.log(
    `👤 ${agente} (${agentId})\n` +
    `📅 ${meses.length} meses (${meses.map(x => x.etiqueta).join(", ")}) · ${diasTotales} días\n` +
    `📄 ${meses.length} archivos — se genera uno por mes, también si el mes viene vacío\n` +
    `⏱️ estimado ~${Math.ceil(diasTotales * (CFG.pausaMs + 400) / 60000)} min. No cierres la pestaña.`
  );

  if (CFG.verificarSesion) {
    const ult = meses[meses.length - 1];
    const muestra = [ult.desde, addDays(ult.desde, 9), addDays(ult.desde, 19)];
    let n = 0;
    for (const d of muestra) { try { n += (await fetchDia(d)).length; } catch { /* seguir */ } await sleep(200); }
    if (n === 0) {
      console.error(
        `❌ 0 movimientos en los días de muestra (${muestra.join(", ")}).\n` +
        `   Casi seguro NO estás logueado como "${agente}".\n` +
        `   → Entrá al panel CON LA CUENTA DE ${agente} y volvé a correr.\n` +
        `   (Si estás seguro de la sesión, poné verificarSesion: false.)`
      );
      return;
    }
    console.log(`✅ Sesión OK — ${n} movimientos en los días de muestra.`);
  }

  // ── XLSX ──────────────────────────────────────────────────────────────────
  if (!window.XLSX) {
    await new Promise((ok, err) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
      s.onload = ok; s.onerror = () => err(new Error("no XLSX"));
      document.head.appendChild(s);
    }).catch(() => console.warn("⚠️ XLSX no disponible — se bajará CSV."));
  }
  const dl = (blob, fn) => {
    const u = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: u, download: fn });
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(u);
  };

  const hMov  = ["id","fecha","hora","jugador","tipo","monto","de","a","iniciador","operation_raw","nota"];
  const hJug  = ["jugador","cargas","cantCargas","retiros","cantRetiros","neto","promedioCarga","primeraCarga","ultimaCarga","ultimoRetiro","ultimoMovimiento"];
  const hHora = ["franja","cargasCant","cargasMonto","retirosCant","retirosMonto","movTotal"];
  const A = agente.toLowerCase();
  const resumen = [], opsGlobales = {};

  // ── Loop por mes — SIEMPRE genera archivo ─────────────────────────────────
  for (const mes of meses) {
    console.log(`\n══ ${agente} · ${mes.etiqueta} ══`);
    const vistos = new Set(), tx = [];
    let incompleto = false, ultimoDia = mes.desde;

    try {
      for (let d = mes.desde; d < mes.hasta; d = addDays(d, 1)) {
        ultimoDia = d;
        const arr = await fetchDia(d);
        let nuevos = 0;
        for (const t of arr) { if (!vistos.has(t.id)) { vistos.add(t.id); tx.push(t); nuevos++; } }
        if (arr.length) console.log(`   ${d}: ${arr.length} traídos | ${nuevos} nuevos | acum ${tx.length}`);
        await sleep(CFG.pausaMs);
      }
    } catch (err) {
      incompleto = true;
      console.error(`   ❌ cortado en ${ultimoDia}: ${err.message} — guardo ${tx.length} filas como PARCIAL y sigo.`);
    }

    const MOV = tx.map(t => {
      const from = String(t.from_user ?? ""), to = String(t.to_user ?? "");
      opsGlobales[String(t.operation)] = (opsGlobales[String(t.operation)] ?? 0) + 1;
      const ms = aMs(t.created_at);
      return {
        ms, id: t.id,
        fecha: ms ? fechaDe(ms) : "", hora: ms ? horaDe(ms) : "",
        jugador: from.toLowerCase() === A ? to : from,
        tipo: t.operation === 0 ? "Depósito" : "Retiro",
        monto: Number(t.amount) || 0,
        de: from, a: to,
        iniciador: t.initiator_user ?? "",
        operation_raw: t.operation,
        nota: t.note ?? "",
      };
    }).filter(m => m.jugador && m.jugador.toLowerCase() !== A)
      .sort((a, b) => a.ms - b.ms);

    let totC = 0, totR = 0, nC = 0, nR = 0;
    for (const m of MOV) { if (m.tipo === "Depósito") { totC += m.monto; nC++; } else { totR += m.monto; nR++; } }

    // Jugadores
    const mapa = new Map();
    for (const m of MOV) {
      let r = mapa.get(m.jugador);
      if (!r) { r = { jugador: m.jugador, cargas: 0, cantCargas: 0, retiros: 0, cantRetiros: 0, _pc: null, _uc: null, _ur: null, _um: null }; mapa.set(m.jugador, r); }
      if (m.tipo === "Depósito") {
        r.cargas += m.monto; r.cantCargas++;
        if (r._pc === null || m.ms < r._pc) r._pc = m.ms;
        if (r._uc === null || m.ms > r._uc) r._uc = m.ms;
      } else {
        r.retiros += m.monto; r.cantRetiros++;
        if (r._ur === null || m.ms > r._ur) r._ur = m.ms;
      }
      if (r._um === null || m.ms > r._um) r._um = m.ms;
    }
    const st = ms => ms ? `${fechaDe(ms)} ${horaDe(ms)}` : "";
    const jugadores = [...mapa.values()].map(r => ({
      jugador: r.jugador,
      cargas: r2(r.cargas), cantCargas: r.cantCargas,
      retiros: r2(r.retiros), cantRetiros: r.cantRetiros,
      neto: r2(r.cargas - r.retiros),
      promedioCarga: r.cantCargas ? r2(r.cargas / r.cantCargas) : 0,
      primeraCarga: st(r._pc), ultimaCarga: st(r._uc), ultimoRetiro: st(r._ur), ultimoMovimiento: st(r._um),
    })).sort((a, b) => b.cargas - a.cargas);
    jugadores.push({ jugador: "TOTAL", cargas: r2(totC), cantCargas: nC, retiros: r2(totR), cantRetiros: nR, neto: r2(totC - totR) });

    // Por hora (las 24 franjas siempre, aunque el mes esté vacío)
    const H = Array.from({ length: 24 }, () => ({ cargasCant: 0, cargasMonto: 0, retirosCant: 0, retirosMonto: 0 }));
    for (const m of MOV) {
      const b = H[hourOf(m.ms)];
      if (m.tipo === "Depósito") { b.cargasCant++; b.cargasMonto += m.monto; }
      else                       { b.retirosCant++; b.retirosMonto += m.monto; }
    }
    const porHora = H.map((b, h) => ({
      franja: `${p2(h)}:00–${p2(h)}:59`,
      cargasCant: b.cargasCant, cargasMonto: r2(b.cargasMonto),
      retirosCant: b.retirosCant, retirosMonto: r2(b.retirosMonto),
      movTotal: b.cargasCant + b.retirosCant,
    }));
    porHora.push(porHora.reduce((a, r) => { for (const k in a) if (k !== "franja") a[k] = r2(a[k] + r[k]); return a; },
      { franja: "TOTAL", cargasCant: 0, cargasMonto: 0, retirosCant: 0, retirosMonto: 0, movTotal: 0 }));

    const estado = incompleto ? `PARCIAL (hasta ${ultimoDia})` : (MOV.length ? "completo" : "sin movimientos");
    console.log(MOV.length
      ? `   ✅ ${MOV.length} movs | Cargas ${nC}: $${fmtN(r2(totC))} | Retiros ${nR}: $${fmtN(r2(totR))} | ${mapa.size} jugadores${incompleto ? " | ⚠️ PARCIAL" : ""}`
      : `   ○ sin movimientos en el mes — igual se genera el archivo`);
    resumen.push({ mes: mes.etiqueta, movs: MOV.length, cargas: r2(totC), retiros: r2(totR), jugadores: mapa.size, estado });

    // Archivo del mes — SIEMPRE
    const rows = MOV.map(({ ms, ...r }) => r);
    const base = `ganamos_${agente}_${mes.etiqueta}${incompleto ? "_PARCIAL" : ""}`;
    try {
      if (!window.XLSX) throw new Error("sin XLSX");
      const wb = XLSX.utils.book_new();

      const ws1 = XLSX.utils.json_to_sheet(jugadores, { header: hJug });
      ws1["!cols"] = [{wch:22},{wch:14},{wch:11},{wch:14},{wch:11},{wch:14},{wch:13},{wch:19},{wch:19},{wch:19},{wch:19}];
      XLSX.utils.book_append_sheet(wb, ws1, "Jugadores");

      const ws2 = XLSX.utils.json_to_sheet(rows, { header: hMov });
      ws2["!cols"] = [{wch:14},{wch:11},{wch:10},{wch:20},{wch:10},{wch:14},{wch:18},{wch:18},{wch:16},{wch:8},{wch:20}];
      if (rows.length) ws2["!autofilter"] = { ref: XLSX.utils.encode_range({ s:{r:0,c:0}, e:{r:rows.length, c:hMov.length-1} }) };
      XLSX.utils.book_append_sheet(wb, ws2, "Movimientos");

      const ws3 = XLSX.utils.json_to_sheet(porHora, { header: hHora });
      ws3["!cols"] = [{wch:13},{wch:12},{wch:15},{wch:12},{wch:15},{wch:11}];
      XLSX.utils.book_append_sheet(wb, ws3, "Por hora");

      dl(new Blob([XLSX.write(wb, { bookType: "xlsx", type: "array" })],
        { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${base}.xlsx`);
      console.log(`   💾 ${base}.xlsx`);
    } catch {
      const esc = v => { const s = String(v ?? ""); return /[;"\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
      const csv = hMov.join(";") + "\n" + rows.map(r => hMov.map(h => esc(r[h])).join(";")).join("\n");
      dl(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" }), `${base}.csv`);
      console.warn(`   💾 ${base}.csv`);
    }
    await sleep(600);
  }

  console.log(`\n═══ RESUMEN — ${agente} ═══`);
  console.table(resumen);
  console.log("Valores de `operation` (0 = depósito; el resto se clasificó como retiro):");
  console.table(opsGlobales);
  const malos = resumen.filter(r => String(r.estado).startsWith("PARCIAL"));
  if (malos.length) console.warn(`⚠️ ${malos.length} mes(es) cortados por error — volvé a correr esos.`);
  else console.log(`✅ ${meses.length} archivos generados, uno por mes.`);
  console.log(`\n➡️ Próximo: salir, entrar como otro agente, cambiar CFG.agente y repetir.`);
})();
