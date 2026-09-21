/**
 * Ganamos — exportador mensual. UN ARCHIVO POR MES, con todos los datos posibles.
 * ⚠️ Correr LOGUEADO CON LA CUENTA DEL AGENTE.
 *
 * Dos fuentes, siempre combinadas:
 *   · TOTALES DIARIOS del panel (transfers_only=false) → existen para todo el histórico.
 *     Son la fuente oficial de cargas/retiros del mes.
 *   · DETALLE transaccional (transfers_only=true) → solo ~60 días hacia atrás.
 *     Permite el análisis por jugador, por hora, etc.
 * La "cobertura" mide qué % de las cargas del panel explica el detalle. Si es baja,
 * el análisis por jugador está incompleto y el archivo lo indica.
 *
 * Hojas: Resumen · Por día · Por día semana  (siempre)
 *        Jugadores · Movimientos · Por hora  (cuando hay detalle)
 */
(async () => {
  const IDS = {
    adminbtc: 23851783, adminzeus: 23851856, adminroyal: 24044323,
    admbigwin: 24045611, amdfarabet: 24050612, adminfara: 24050926,
    adminimperio: 34139043, admmega: 27622997,
  };

  const CFG = {
    AGENT_USER: "adminroyal",    // ← EL AGENTE CON EL QUE ESTÁS LOGUEADO
    MESES: ["2026-04"],          // uno o varios: ["2026-03","2026-04"]
    COUNT: 500,
    PAUSA_MS: 300,
    MAX_REINTENTOS: 3,
    COBERTURA_MIN: 0.95,         // por debajo, el detalle se marca como parcial
    EXCLUIR: [],
  };

  CFG.AGENT_ID = IDS[CFG.AGENT_USER];
  if (!CFG.AGENT_ID) return console.error(`❌ No tengo el ID de "${CFG.AGENT_USER}". Agregalo a IDS.`);
  const BASE  = `https://agents.ganamosnet.org/api/agent_admin/user/${CFG.AGENT_ID}/payment/history/`;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const log   = (...a) => console.log("[GANAMOS]", ...a);
  const p2    = n => String(n).padStart(2, "0");
  const r2    = n => Math.round(n * 100) / 100;
  const pctTxt = x => `${r2(x * 100)}%`;
  const fmtN  = n => n.toLocaleString("es-AR", { minimumFractionDigits: 2 });

  const addDays = (iso, n) => { const [y,m,d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m-1, d+n)).toISOString().slice(0,10); };
  const aMs = c => { if (!c) return 0; const s = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(c) ? c : `${c}Z`; const t = new Date(s).getTime(); return Number.isFinite(t) ? t : 0; };
  const arg = ms => new Date(ms - 3 * 3600000);          // AR = UTC-3
  const fechaDe = ms => { const d = arg(ms); return `${p2(d.getUTCDate())}/${p2(d.getUTCMonth()+1)}/${d.getUTCFullYear()}`; };
  const horaDe  = ms => { const d = arg(ms); return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`; };
  const stamp   = ms => ms ? `${fechaDe(ms)} ${horaDe(ms)}` : "";
  const isoDia  = ms => { const d = arg(ms); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth()+1)}-${p2(d.getUTCDate())}`; };
  const DIAS_SEM = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
  const semanaDe = iso => new Date(`${iso}T12:00:00Z`).getUTCDay();

  const mediana = a => { if (!a.length) return 0; const s = [...a].sort((x,y)=>x-y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m-1]+s[m])/2; };
  const moda = m => { let k = null, v = -1; for (const [kk, vv] of m) if (vv > v) { v = vv; k = kk; } return k; };

  const params = (from, to, page, count, soloFilas) => new URLSearchParams({
    date_from: from, date_to: to,
    username: "", role: "0",
    is_direct_structure: "false",
    is_higher_transaction_only: "false",
    is_withdrawal_transfers: "true",
    is_deposit_transfers: "true",
    page: String(page), count: String(count),
    is_bonus_deposits: "false",
    transfers_only: soloFilas ? "true" : "false",
  });

  const leer = async (url) => {
    const res = await fetch(url, { credentials: "include" });
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`Sesión caída (HTTP ${res.status})`), { fatal: true });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.status !== 0) {
      const msg = String(json.error_message ?? json.status);
      if (/unauthori|forbidden|permission/i.test(msg)) throw Object.assign(new Error(msg), { fatal: true });
      throw new Error(msg.slice(0, 100));
    }
    return json;
  };

  const conReintentos = async (fn, etiqueta) => {
    for (let i = 0; ; i++) {
      try { return await fn(); }
      catch (e) {
        if (e.fatal || i >= CFG.MAX_REINTENTOS) throw e;
        const espera = CFG.PAUSA_MS * Math.pow(3, i + 1);
        log(`   ⚠️ ${etiqueta}: ${e.message}. Reintento ${i+1}/${CFG.MAX_REINTENTOS} en ${Math.round(espera/1000)}s`);
        await sleep(espera);
      }
    }
  };

  // ── Detalle (filas) ───────────────────────────────────────────────────────
  const fetchVentana = (from, to) => conReintentos(async () => {
    const out = [];
    for (let page = 0; page < 200; page++) {
      const j = await leer(`${BASE}?${params(from, to, page, CFG.COUNT, true)}`);
      const arr = j.result?.transfers || [];
      out.push(...arr);
      if (arr.length < CFG.COUNT) break;
      await sleep(CFG.PAUSA_MS);
    }
    return out;
  }, from.slice(0, 16));

  const fetchDia = async (dia) => {
    try { return await fetchVentana(`${dia}T00:00:00`, `${addDays(dia,1)}T00:00:00`); }
    catch (e) {
      if (e.fatal) throw e;
      log(`   ↯ ${dia}: falla el día entero (${e.message}). Parto en franjas de 6 h.`);
      const hs = ["00:00:00","06:00:00","12:00:00","18:00:00"], out = [];
      for (let i = 0; i < hs.length; i++) {
        const to = i < 3 ? `${dia}T${hs[i+1]}` : `${addDays(dia,1)}T00:00:00`;
        out.push(...await fetchVentana(`${dia}T${hs[i]}`, to));
        await sleep(CFG.PAUSA_MS);
      }
      return out;
    }
  };

  // ── Totales del panel (agregados) ─────────────────────────────────────────
  const buscarNum = (n, pat, prof = 0) => {
    if (prof > 6 || !n || typeof n !== "object") return null;
    for (const [k, v] of Object.entries(n)) {
      if (typeof v === "number" && pat.test(k)) return v;
      if (typeof v === "string" && pat.test(k) && !isNaN(parseFloat(v))) return parseFloat(v);
      if (v && typeof v === "object") { const r = buscarNum(v, pat, prof + 1); if (r !== null) return r; }
    }
    return null;
  };
  const fetchTotalesDia = (dia) => conReintentos(async () => {
    const j = await leer(`${BASE}?${params(`${dia}T00:00:00`, `${addDays(dia,1)}T00:00:00`, 0, 10, false)}`);
    return { dep: buscarNum(j, /deposit|ingres|carga/i) ?? 0, ret: buscarNum(j, /withdraw|retir|egres/i) ?? 0 };
  }, `${dia} totales`);

  if (!window.XLSX) {
    await new Promise((ok, err) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
      s.onload = ok; s.onerror = () => err(new Error("no XLSX"));
      document.head.appendChild(s);
    });
  }
  const dl = (blob, fn) => {
    const u = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: u, download: fn });
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(u);
  };

  const A = CFG.AGENT_USER.toLowerCase();

  // ── Chequeo previo de sesión ──────────────────────────────────────────────
  try {
    const hoy = new Date().toISOString().slice(0, 10);
    await fetchVentana(`${addDays(hoy, -1)}T00:00:00`, `${hoy}T00:00:00`);
    log(`✅ Sesión OK para ${CFG.AGENT_USER} (${CFG.AGENT_ID})`);
  } catch (e) {
    if (e.fatal) {
      return console.error(
        `❌ El servidor responde "${e.message}" para ${CFG.AGENT_USER} (${CFG.AGENT_ID}).\n` +
        `   La sesión abierta no corresponde a ese agente. Poné en CFG.AGENT_USER el\n` +
        `   usuario que figura arriba a la derecha del panel.`
      );
    }
    console.warn(`⚠️ Chequeo previo con error (${e.message}); sigo igual.`);
  }

  // ══ Loop de meses ═════════════════════════════════════════════════════════
  for (const mes of CFG.MESES) {
    const [Y, M] = mes.split("-").map(Number);
    const desde = `${Y}-${p2(M)}-01`;
    const hasta = M === 12 ? `${Y+1}-01-01` : `${Y}-${p2(M+1)}-01`;
    const dias = [];
    for (let d = desde; d < hasta; d = addDays(d, 1)) dias.push(d);
    const finMesMs = new Date(`${hasta}T00:00:00Z`).getTime();
    const dia1 = new Date(`${desde}T00:00:00Z`).getTime();

    console.log(`\n╔═══ ${CFG.AGENT_USER} · ${mes} · ${dias.length} días ═══╗`);

    const tot = new Map();                 // dia -> {dep, ret}
    const vistos = new Set(), tx = [], fallidos = [];

    for (const d of dias) {
      try { tot.set(d, await fetchTotalesDia(d)); }
      catch (e) {
        if (e.fatal) return console.error(`❌ ${e.message} — corto la corrida.`);
        tot.set(d, { dep: 0, ret: 0 }); fallidos.push({ dia: d, fuente: "totales", error: e.message });
      }
      await sleep(CFG.PAUSA_MS);

      try {
        const arr = await fetchDia(d);
        for (const t of arr) if (!vistos.has(t.id)) { vistos.add(t.id); tx.push(t); }
      } catch (e) {
        if (e.fatal) return console.error(`❌ ${e.message} — corto la corrida.`);
        fallidos.push({ dia: d, fuente: "detalle", error: e.message });
      }
      const t = tot.get(d);
      log(`${d}: panel dep $${fmtN(r2(t.dep))} · ret $${fmtN(r2(t.ret))} | detalle acum ${tx.length} movs`);
      await sleep(CFG.PAUSA_MS);
    }
    if (fallidos.length) { console.warn(`⚠️ ${fallidos.length} consulta(s) fallidas:`); console.table(fallidos); }

    // ── Detalle normalizado ────────────────────────────────────────────────
    const MOV = tx.map(t => {
      const from = String(t.from_user ?? ""), to = String(t.to_user ?? "");
      const ms = aMs(t.created_at), d = arg(ms);
      return {
        ms, id: t.id,
        fecha: fechaDe(ms), hora: horaDe(ms), dia: isoDia(ms),
        horaNum: d.getUTCHours(), diaSemana: d.getUTCDay(),
        jugador: from.toLowerCase() === A ? to : from,
        tipo: t.operation === 0 ? "Depósito" : "Retiro",
        monto: Number(t.amount) || 0,
        de: from, a: to,
        iniciador: t.initiator_user ?? "",
        operation_raw: t.operation,
        nota: t.note || "",
      };
    }).filter(m => m.jugador && m.jugador.toLowerCase() !== A && !CFG.EXCLUIR.includes(m.jugador))
      .sort((a, b) => a.ms - b.ms);

    // ── Totales: panel (oficial) vs detalle ────────────────────────────────
    let aggC = 0, aggR = 0;
    for (const v of tot.values()) { aggC += v.dep; aggR += v.ret; }
    let detC = 0, detR = 0, nC = 0, nR = 0;
    for (const m of MOV) { if (m.tipo === "Depósito") { detC += m.monto; nC++; } else { detR += m.monto; nR++; } }
    const cobertura = aggC ? detC / aggC : (MOV.length ? 1 : 0);
    const tipoArchivo = !MOV.length ? "SOLO-TOTALES" : cobertura < CFG.COBERTURA_MIN ? "DETALLE-PARCIAL" : "COMPLETO";

    // ── Por día (panel + detalle) ──────────────────────────────────────────
    const detDia = new Map();
    for (const m of MOV) {
      const b = detDia.get(m.dia) ?? { movs: 0, cargas: 0, jug: new Set() };
      b.movs++; b.jug.add(m.jugador); if (m.tipo === "Depósito") b.cargas += m.monto;
      detDia.set(m.dia, b);
    }
    const porDia = dias.map(d => {
      const t = tot.get(d), b = detDia.get(d);
      return {
        fecha: d, diaSemana: DIAS_SEM[semanaDe(d)],
        cargas: r2(t.dep), retiros: r2(t.ret), neto: r2(t.dep - t.ret),
        movsDetalle: b?.movs ?? 0, jugadoresDetalle: b?.jug.size ?? 0,
        coberturaDetalle: t.dep ? pctTxt((b?.cargas ?? 0) / t.dep) : "",
      };
    });
    const diasConMov = porDia.filter(r => r.cargas || r.retiros);
    const mejorDia = [...porDia].sort((a, b) => b.cargas - a.cargas)[0];
    const peorNeto = [...porDia].sort((a, b) => a.neto - b.neto)[0];
    porDia.push({ fecha: "TOTAL", diaSemana: "", cargas: r2(aggC), retiros: r2(aggR), neto: r2(aggC - aggR),
      movsDetalle: MOV.length, jugadoresDetalle: new Set(MOV.map(m => m.jugador)).size, coberturaDetalle: pctTxt(cobertura) });

    // ── Por día de semana (panel; + detalle si hay) ────────────────────────
    const S = Array.from({ length: 7 }, () => ({ dias: 0, c: 0, r: 0, movs: 0, jug: new Set() }));
    for (const d of dias) { const t = tot.get(d), s = S[semanaDe(d)]; s.dias++; s.c += t.dep; s.r += t.ret; }
    for (const m of MOV) { const s = S[m.diaSemana]; s.movs++; s.jug.add(m.jugador); }
    const porSemana = S.map((s, i) => ({
      diaSemana: DIAS_SEM[i], diasEnElMes: s.dias,
      cargas: r2(s.c), retiros: r2(s.r), neto: r2(s.c - s.r),
      promedioCargasPorDia: s.dias ? r2(s.c / s.dias) : 0,
      movsDetalle: s.movs, jugadoresDetalle: s.jug.size,
    }));

    // ── Análisis por jugador (solo con detalle) ────────────────────────────
    let jugadores = [], porHora = [], P90 = 0, P70 = 0;
    if (MOV.length) {
      const J = new Map();
      for (const m of MOV) {
        let r = J.get(m.jugador);
        if (!r) { r = { jugador: m.jugador, cargas: 0, nC: 0, retiros: 0, nR: 0, montosC: [], montosR: [],
          dias: new Set(), diasCarga: new Set(), horas: new Map(), semana: new Map(), inic: new Map(),
          pc: null, uc: null, ur: null, um: null, tsCargas: [] }; J.set(m.jugador, r); }
        r.dias.add(m.dia);
        r.horas.set(m.horaNum, (r.horas.get(m.horaNum) ?? 0) + 1);
        r.semana.set(m.diaSemana, (r.semana.get(m.diaSemana) ?? 0) + 1);
        if (m.iniciador) r.inic.set(m.iniciador, (r.inic.get(m.iniciador) ?? 0) + 1);
        if (m.tipo === "Depósito") {
          r.cargas += m.monto; r.nC++; r.montosC.push(m.monto); r.diasCarga.add(m.dia); r.tsCargas.push(m.ms);
          if (r.pc === null || m.ms < r.pc) r.pc = m.ms;
          if (r.uc === null || m.ms > r.uc) r.uc = m.ms;
        } else {
          r.retiros += m.monto; r.nR++; r.montosR.push(m.monto);
          if (r.ur === null || m.ms > r.ur) r.ur = m.ms;
        }
        if (r.um === null || m.ms > r.um) r.um = m.ms;
      }
      const base = [...J.values()].map(r => {
        const iv = []; for (let i = 1; i < r.tsCargas.length; i++) iv.push((r.tsCargas[i] - r.tsCargas[i-1]) / 86400000);
        return {
          jugador: r.jugador,
          cargas: r2(r.cargas), cantCargas: r.nC, retiros: r2(r.retiros), cantRetiros: r.nR,
          neto: r2(r.cargas - r.retiros),
          promedioCarga: r.nC ? r2(r.cargas / r.nC) : 0, medianaCarga: r.nC ? r2(mediana(r.montosC)) : 0,
          cargaMin: r.nC ? r2(Math.min(...r.montosC)) : 0, cargaMax: r.nC ? r2(Math.max(...r.montosC)) : 0,
          promedioRetiro: r.nR ? r2(r.retiros / r.nR) : 0, retiroMax: r.nR ? r2(Math.max(...r.montosR)) : 0,
          ratioRetiro: r.cargas ? r2(r.retiros / r.cargas) : 0,
          diasActivos: r.dias.size, diasConCarga: r.diasCarga.size,
          cargasPorDiaActivo: r.dias.size ? r2(r.nC / r.dias.size) : 0,
          intervaloPromedioDias: iv.length ? r2(iv.reduce((a,b)=>a+b,0) / iv.length) : "",
          franjaHabitual: `${p2(moda(r.horas) ?? 0)}:00`, diaHabitual: DIAS_SEM[moda(r.semana) ?? 0],
          iniciadorPrincipal: moda(r.inic) ?? "", cantIniciadores: r.inic.size,
          primeraCarga: stamp(r.pc), ultimaCarga: stamp(r.uc), ultimoRetiro: stamp(r.ur), ultimoMovimiento: stamp(r.um),
          diasDesdeUltimaCarga: r.uc ? Math.floor((finMesMs - r.uc) / 86400000) : "",
          antiguedadDias: r.pc ? Math.floor((finMesMs - r.pc) / 86400000) : "",
          arrancoEsteMes: r.pc && r.pc - dia1 < 86400000 * 3 ? "no (ya venía)" : "sí",
        };
      });
      const orden = base.map(b => b.cargas).sort((a, b) => a - b);
      const q = x => orden.length ? orden[Math.min(orden.length - 1, Math.floor(orden.length * x))] : 0;
      P90 = q(0.90); P70 = q(0.70); const P40 = q(0.40);
      jugadores = base.map(b => ({
        ...b,
        segmento: b.cargas >= P90 ? "super_vip" : b.cargas >= P70 ? "vip" : b.cargas >= P40 ? "medio" : "bajo",
        actividad: b.diasDesdeUltimaCarga === "" ? "sin_cargas"
                 : b.diasDesdeUltimaCarga <= 7 ? "activo" : b.diasDesdeUltimaCarga <= 15 ? "tibio"
                 : b.diasDesdeUltimaCarga <= 30 ? "en_riesgo" : "inactivo",
      })).sort((a, b) => b.cargas - a.cargas);

      const H = Array.from({ length: 24 }, () => ({ c:0, cm:0, r:0, rm:0, j:new Set() }));
      for (const m of MOV) { const b = H[m.horaNum]; b.j.add(m.jugador); if (m.tipo === "Depósito") { b.c++; b.cm += m.monto; } else { b.r++; b.rm += m.monto; } }
      porHora = H.map((b, h) => ({ franja: `${p2(h)}:00–${p2(h)}:59`, cantCargas: b.c, cargas: r2(b.cm),
        cantRetiros: b.r, retiros: r2(b.rm), jugadores: b.j.size, movTotal: b.c + b.r }));
    }

    // ── Resumen ────────────────────────────────────────────────────────────
    const top10 = jugadores.slice(0, 10).reduce((a, j) => a + j.cargas, 0);
    const resumen = [
      { seccion: "General",  metrica: "Agente",                        valor: `${CFG.AGENT_USER} (${CFG.AGENT_ID})` },
      { seccion: "General",  metrica: "Mes",                           valor: mes },
      { seccion: "General",  metrica: "Tipo de archivo",               valor: tipoArchivo },
      { seccion: "Panel",    metrica: "Total cargas",                  valor: r2(aggC) },
      { seccion: "Panel",    metrica: "Total retiros",                 valor: r2(aggR) },
      { seccion: "Panel",    metrica: "Neto (cargas - retiros)",       valor: r2(aggC - aggR) },
      { seccion: "Panel",    metrica: "% de retiro sobre carga",       valor: aggC ? pctTxt(aggR / aggC) : "0%" },
      { seccion: "Panel",    metrica: "Días con movimiento",           valor: diasConMov.length },
      { seccion: "Panel",    metrica: "Promedio diario de cargas",     valor: dias.length ? r2(aggC / dias.length) : 0 },
      { seccion: "Panel",    metrica: "Día de mayor carga",            valor: mejorDia ? `${mejorDia.fecha} ($${fmtN(mejorDia.cargas)})` : "" },
      { seccion: "Panel",    metrica: "Día de peor neto",              valor: peorNeto ? `${peorNeto.fecha} ($${fmtN(peorNeto.neto)})` : "" },
      { seccion: "Detalle",  metrica: "Movimientos en el detalle",     valor: MOV.length },
      { seccion: "Detalle",  metrica: "Cargas en el detalle",          valor: r2(detC) },
      { seccion: "Detalle",  metrica: "Cobertura del detalle",         valor: pctTxt(cobertura) },
    ];
    if (tipoArchivo !== "COMPLETO") resumen.push({ seccion: "Detalle", metrica: "⚠️ Atención",
      valor: MOV.length
        ? `El análisis por jugador cubre solo ${pctTxt(cobertura)} de las cargas del mes (el backend conserva el detalle ~60 días).`
        : "Sin detalle por jugador: el mes está fuera de la ventana de ~60 días del backend." });
    if (MOV.length) resumen.push(
      { seccion: "Jugadores", metrica: "Jugadores únicos",            valor: jugadores.length },
      { seccion: "Jugadores", metrica: "Cantidad de cargas",          valor: nC },
      { seccion: "Jugadores", metrica: "Cantidad de retiros",         valor: nR },
      { seccion: "Jugadores", metrica: "Ticket promedio de carga",    valor: nC ? r2(detC / nC) : 0 },
      { seccion: "Jugadores", metrica: "Mediana de carga",            valor: r2(mediana(MOV.filter(m => m.tipo === "Depósito").map(m => m.monto))) },
      { seccion: "Jugadores", metrica: "Carga promedio por jugador",  valor: jugadores.length ? r2(detC / jugadores.length) : 0 },
      { seccion: "Jugadores", metrica: "Cargas por jugador",          valor: jugadores.length ? r2(nC / jugadores.length) : 0 },
      { seccion: "Jugadores", metrica: "Concentración top 10",        valor: detC ? pctTxt(top10 / detC) : "0%" },
      { seccion: "Jugadores", metrica: "Activos (≤7 días)",           valor: jugadores.filter(j => j.actividad === "activo").length },
      { seccion: "Jugadores", metrica: "Tibios (8-15 días)",          valor: jugadores.filter(j => j.actividad === "tibio").length },
      { seccion: "Jugadores", metrica: "En riesgo (16-30 días)",      valor: jugadores.filter(j => j.actividad === "en_riesgo").length },
      { seccion: "Jugadores", metrica: "Umbral super_vip (P90)",      valor: r2(P90) },
      { seccion: "Jugadores", metrica: "Umbral vip (P70)",            valor: r2(P70) },
    );

    console.log(`✅ ${mes} [${tipoArchivo}] panel: cargas $${fmtN(r2(aggC))} · retiros $${fmtN(r2(aggR))} | detalle: ${MOV.length} movs, cobertura ${pctTxt(cobertura)}`);
    console.table(resumen);

    // ── Archivo ────────────────────────────────────────────────────────────
    const wb = XLSX.utils.book_new();
    const add = (rows, header, nombre, cols) => {
      const ws = XLSX.utils.json_to_sheet(rows, { header });
      if (cols) ws["!cols"] = cols;
      if (rows.length) ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s:{r:0,c:0}, e:{r:rows.length, c:header.length-1} }) };
      XLSX.utils.book_append_sheet(wb, ws, nombre);
    };

    add(resumen, ["seccion","metrica","valor"], "Resumen", [{wch:11},{wch:28},{wch:60}]);
    add(porDia, ["fecha","diaSemana","cargas","retiros","neto","movsDetalle","jugadoresDetalle","coberturaDetalle"], "Por día",
      [{wch:12},{wch:11},{wch:15},{wch:15},{wch:15},{wch:12},{wch:16},{wch:16}]);
    add(porSemana, ["diaSemana","diasEnElMes","cargas","retiros","neto","promedioCargasPorDia","movsDetalle","jugadoresDetalle"], "Por día semana",
      [{wch:12},{wch:12},{wch:15},{wch:15},{wch:15},{wch:20},{wch:12},{wch:16}]);

    if (MOV.length) {
      const hJ = ["jugador","segmento","actividad","cargas","cantCargas","retiros","cantRetiros","neto",
        "promedioCarga","medianaCarga","cargaMin","cargaMax","promedioRetiro","retiroMax","ratioRetiro",
        "diasActivos","diasConCarga","cargasPorDiaActivo","intervaloPromedioDias","diasDesdeUltimaCarga","antiguedadDias",
        "franjaHabitual","diaHabitual","iniciadorPrincipal","cantIniciadores","arrancoEsteMes",
        "primeraCarga","ultimaCarga","ultimoRetiro","ultimoMovimiento"];
      add([...jugadores, { jugador:"TOTAL", cargas:r2(detC), cantCargas:nC, retiros:r2(detR), cantRetiros:nR, neto:r2(detC-detR) }],
        hJ, "Jugadores", [{wch:22},{wch:11},{wch:11},{wch:14},{wch:11},{wch:14},{wch:11},{wch:14},{wch:14},{wch:13},{wch:11},{wch:12},{wch:14},{wch:12},{wch:11},{wch:11},{wch:12},{wch:17},{wch:19},{wch:19},{wch:14},{wch:13},{wch:12},{wch:18},{wch:15},{wch:14},{wch:19},{wch:19},{wch:19},{wch:19}]);
      add(MOV.map(({ ms, dia, horaNum, diaSemana, ...r }) => r),
        ["id","fecha","hora","jugador","tipo","monto","de","a","iniciador","operation_raw","nota"], "Movimientos",
        [{wch:14},{wch:11},{wch:10},{wch:20},{wch:10},{wch:14},{wch:18},{wch:18},{wch:16},{wch:8},{wch:22}]);
      add(porHora, ["franja","cantCargas","cargas","cantRetiros","retiros","jugadores","movTotal"], "Por hora",
        [{wch:13},{wch:11},{wch:15},{wch:12},{wch:15},{wch:11},{wch:10}]);
    }

    const sufijo = tipoArchivo === "COMPLETO" ? "" : `_${tipoArchivo}`;
    const nombre = `ganamos_${CFG.AGENT_USER}_${mes}${sufijo}${fallidos.length ? "_CON-FALLAS" : ""}.xlsx`;
    dl(new Blob([XLSX.write(wb, { bookType:"xlsx", type:"array" })],
      { type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), nombre);
    console.log(`💾 ${nombre}`);

    window.GANAMOS_ULTIMO = { mes, MOV, jugadores, porDia, resumen };
    await sleep(800);
  }

  console.log("\n✅ Listo. Para otro mes: cambiá CFG.MESES y volvé a correr.");
})();
