/**
 * Ganamos — exportador de movimientos por rango (formato "royal").
 * Un único XLSX con hojas Jugadores + Movimientos.
 *
 * ⚠️ Correr LOGUEADO CON LA CUENTA DEL AGENTE (no la de admin).
 * Nota: el detalle transaccional solo está disponible para la ventana reciente
 * (~60 días); los meses anteriores devuelven listas vacías.
 */
(async () => {
  const CONFIG = {
    AGENT_ID: 24050926,
    AGENT_USER: "adminfara",
    FECHA_INICIO: "2026-03-01",
    FECHA_FIN: "2026-08-31",     // inclusive → 6 meses completos, marzo a agosto
    TZ: "America/Argentina/Buenos_Aires",
    COUNT: 500,
    PAUSA_MS: 300,
    MAX_REINTENTOS: 3,     // ante statement timeout del backend
    EXCLUIR: [],
  };

  const BASE = `https://agents.ganamosnet.org/api/agent_admin/user/${CONFIG.AGENT_ID}/payment/history/`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log("[GANAMOS]", ...a);

  const addDays = (iso, n) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  };

  const ts = (c) => new Date(c + "Z").getTime();
  const fmt = (c) =>
    new Date(c + "Z").toLocaleString("es-AR", {
      timeZone: CONFIG.TZ,
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });

  // Pide una ventana [from, to) — strings "YYYY-MM-DDTHH:MM:SS" — paginando.
  // Reintenta ante errores transitorios del backend (statement timeout de Postgres).
  const fetchVentana = async (from, to, intento = 0) => {
    const salida = [];
    try {
      for (let page = 0; page < 200; page++) {
        const p = new URLSearchParams({
          date_from: from, date_to: to,
          username: "", role: "0",
          is_direct_structure: "false",
          is_higher_transaction_only: "false",
          is_withdrawal_transfers: "true",
          is_deposit_transfers: "true",
          page: String(page), count: String(CONFIG.COUNT),
          is_bonus_deposits: "false",
          transfers_only: "true",
        });
        const res = await fetch(`${BASE}?${p}`, { credentials: "include" });
        if (res.status === 401 || res.status === 403) throw new Error(`Sesión caída (HTTP ${res.status})`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (json.status !== 0) throw new Error(String(json.error_message ?? json.status).slice(0, 120));
        const arr = json.result?.transfers || [];
        salida.push(...arr);
        if (arr.length < CONFIG.COUNT) break;
        await sleep(CONFIG.PAUSA_MS);
      }
      return salida;
    } catch (e) {
      if (intento < CONFIG.MAX_REINTENTOS) {
        const espera = CONFIG.PAUSA_MS * Math.pow(3, intento + 1);
        log(`   ⚠️ ${from.slice(0, 16)} falló (${e.message}). Reintento ${intento + 1}/${CONFIG.MAX_REINTENTOS} en ${Math.round(espera / 1000)}s`);
        await sleep(espera);
        return fetchVentana(from, to, intento + 1);
      }
      throw e;
    }
  };

  // Un día completo. Si el backend no aguanta el día entero (statement timeout),
  // lo parte en franjas de 6 h, que son consultas mucho más chicas.
  const fetchDia = async (dia) => {
    try {
      return await fetchVentana(`${dia}T00:00:00`, `${addDays(dia, 1)}T00:00:00`);
    } catch (e) {
      log(`   ↯ ${dia}: el día entero falla (${e.message}). Lo parto en franjas de 6 h.`);
      const horas = ["00:00:00", "06:00:00", "12:00:00", "18:00:00"];
      const out = [];
      for (let i = 0; i < horas.length; i++) {
        const from = `${dia}T${horas[i]}`;
        const to = i < horas.length - 1 ? `${dia}T${horas[i + 1]}` : `${addDays(dia, 1)}T00:00:00`;
        out.push(...await fetchVentana(from, to));
        await sleep(CONFIG.PAUSA_MS);
      }
      log(`   ✔ ${dia} recuperado por franjas: ${out.length} filas`);
      return out;
    }
  };

  const dias = [];
  for (let d = CONFIG.FECHA_INICIO; d <= CONFIG.FECHA_FIN; d = addDays(d, 1)) dias.push(d);
  log(`${CONFIG.AGENT_USER} (${CONFIG.AGENT_ID}) · ${CONFIG.FECHA_INICIO} → ${CONFIG.FECHA_FIN} · ${dias.length} días`);

  const vistos = new Set();
  const tx = [];
  const porDia = {};
  const diasFallidos = [];

  for (const dia of dias) {
    let arr;
    try {
      arr = await fetchDia(dia);
    } catch (e) {
      // Un día que no se puede recuperar NO cancela la corrida.
      diasFallidos.push({ dia, error: e.message });
      log(`   ❌ ${dia} descartado: ${e.message}`);
      window.GANAMOS_TX = tx;               // lo acumulado queda accesible
      await sleep(CONFIG.PAUSA_MS);
      continue;
    }
    let nuevos = 0;
    for (const t of arr) {
      if (vistos.has(t.id)) continue;
      vistos.add(t.id);
      tx.push(t);
      nuevos++;
    }
    porDia[dia.slice(0, 7)] = (porDia[dia.slice(0, 7)] ?? 0) + nuevos;
    if (arr.length) log(`${dia}: ${arr.length} traídos | ${nuevos} nuevos | acumulado: ${tx.length}`);
    await sleep(CONFIG.PAUSA_MS);
  }

  if (diasFallidos.length) {
    console.warn(`⚠️ ${diasFallidos.length} día(s) no se pudieron traer — el Excel sale sin ellos:`);
    console.table(diasFallidos);
  }

  console.log("=== MOVIMIENTOS POR MES ===");
  console.table(porDia);

  const porOp = {};
  tx.forEach((t) => {
    const k = String(t.operation);
    porOp[k] = porOp[k] || { cantidad: 0, monto: 0 };
    porOp[k].cantidad++;
    porOp[k].monto += Number(t.amount) || 0;
  });
  console.log("=== DESGLOSE POR operation ===");
  console.table(porOp);

  const A = CONFIG.AGENT_USER;
  const clasificar = (t) => ({
    esCarga: t.operation === 0,
    jugador: t.from_user === A ? t.to_user : t.from_user,
  });

  const mapa = new Map();
  for (const t of tx) {
    const { esCarga, jugador } = clasificar(t);
    if (!jugador || jugador === A || CONFIG.EXCLUIR.includes(jugador)) continue;

    const monto = Number(t.amount) || 0;
    const tiempo = ts(t.created_at);

    let r = mapa.get(jugador);
    if (!r) {
      r = { jugador, cargas: 0, cantCargas: 0, retiros: 0, cantRetiros: 0, _pc: null, _uc: null, _ur: null, _um: null };
      mapa.set(jugador, r);
    }

    if (esCarga) {
      r.cargas += monto; r.cantCargas++;
      if (r._pc === null || tiempo < r._pc) r._pc = tiempo;
      if (r._uc === null || tiempo > r._uc) r._uc = tiempo;
    } else {
      r.retiros += monto; r.cantRetiros++;
      if (r._ur === null || tiempo > r._ur) r._ur = tiempo;
    }
    if (r._um === null || tiempo > r._um) r._um = tiempo;
  }

  const iso = (ms) => (ms === null ? "" : fmt(new Date(ms).toISOString().slice(0, 19)));

  const filas = [...mapa.values()].map((r) => ({
    jugador: r.jugador,
    cargas: r.cargas, cantCargas: r.cantCargas,
    retiros: r.retiros, cantRetiros: r.cantRetiros,
    neto: r.cargas - r.retiros,
    promedioCarga: r.cantCargas ? Number((r.cargas / r.cantCargas).toFixed(2)) : 0,
    primeraCarga: iso(r._pc), ultimaCarga: iso(r._uc),
    ultimoRetiro: iso(r._ur), ultimoMovimiento: iso(r._um),
  })).sort((a, b) => b.cargas - a.cargas);

  const totC = filas.reduce((a, r) => a + r.cargas, 0);
  const totR = filas.reduce((a, r) => a + r.retiros, 0);

  console.log("\n=== VERIFICACIÓN ===");
  console.log(`Transacciones: ${tx.length} | Jugadores: ${filas.length}`);
  console.log(`Total cargas:  ${totC.toLocaleString("es-AR")}`);
  console.log(`Total retiros: ${totR.toLocaleString("es-AR")}`);
  console.log(`Neto:          ${(totC - totR).toLocaleString("es-AR")}`);

  if (!window.XLSX) {
    await new Promise((ok, err) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
      s.onload = ok; s.onerror = () => err(new Error("No pude cargar XLSX"));
      document.head.appendChild(s);
    });
  }

  const wb = XLSX.utils.book_new();
  const hoja = XLSX.utils.json_to_sheet(
    [...filas, { jugador: "TOTAL", cargas: totC, retiros: totR, neto: totC - totR }],
    { header: ["jugador","cargas","cantCargas","retiros","cantRetiros","neto","promedioCarga","primeraCarga","ultimaCarga","ultimoRetiro","ultimoMovimiento"] }
  );
  hoja["!cols"] = [{wch:22},{wch:13},{wch:11},{wch:13},{wch:11},{wch:13},{wch:13},{wch:18},{wch:18},{wch:18},{wch:18}];
  XLSX.utils.book_append_sheet(wb, hoja, "Jugadores");

  const movs = tx.map((t) => {
    const { esCarga, jugador } = clasificar(t);
    return {
      id: t.id, fecha: fmt(t.created_at),
      operacion: esCarga ? "Depósito" : "Retiro",
      operation_raw: t.operation,
      jugador, de: t.from_user, a: t.to_user,
      iniciador: t.initiator_user,
      cantidad: Number(t.amount) || 0,
      nota: t.note || "",
    };
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(movs), "Movimientos");

  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const url = URL.createObjectURL(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `ganamos_${CONFIG.AGENT_ID}_${CONFIG.FECHA_INICIO}_a_${CONFIG.FECHA_FIN}.xlsx`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);

  window.GANAMOS_TX = tx;
  window.GANAMOS_RESUMEN = filas;
  console.log("✅ Excel descargado");
  if (diasFallidos.length) {
    console.warn(`⚠️ Faltan ${diasFallidos.length} día(s): ${diasFallidos.map(d => d.dia).join(", ")}`);
    console.warn("   Volvé a correr el script con FECHA_INICIO/FECHA_FIN acotadas a esos días.");
  }
})();
