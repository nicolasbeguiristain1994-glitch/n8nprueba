/**
 * Argenbet — exportador de movimientos por agente (consola del navegador).
 *
 * Uso: abrir admin.argenbet.net logueado, F12 -> Console, pegar y Enter.
 *
 * Baja un XLSX por agente y por mes calendario. Acepta varios agentes en una
 * sola corrida (CFG.agentes). Si a un agente no se le pasa `id`, lo busca por
 * nombre probando endpoints del backoffice; si falla, lo saltea y sigue.
 *
 * Argenbet tiene SOLO 3 agentes operativos (los demás hijos de peaky no operan
 * en esta plataforma): adminbtc 637249 · adminzeus 637252 · adminroyal 637255
 *
 * Resiliencia: el JWT de Argenbet es corto y suele vencer a mitad de una carga
 * histórica. Ante 401 el script espera a que otra pestaña del panel renueve el
 * token en localStorage y retoma; si igual falla, guarda ese mes como PARCIAL
 * y sigue con el siguiente (nunca aborta la corrida entera).
 */
(async () => {
  const CFG = {
    // ── Agentes a exportar ───────────────────────────────────────────────────
    // id: null => se busca por nombre (más lento, no siempre funciona)
    // Los 3 agentes de Argenbet. Descomentá los que necesites rebajar.
    agentes: [
      { username: "adminzeus",  id: "637252" },   // → ofizeus
      // { username: "adminbtc",   id: "637249" }, // → betcoin
      // { username: "adminroyal", id: "637255" }, // → royal
    ],

    // ── Rango: se parte en meses calendario, un archivo por mes ──────────────
    desde: "2026-03-01",   // inclusive
    hasta: "2026-09-01",   // EXCLUSIVE — el último mes bajado es agosto

    tz: "-03:00",
    operations: [],        // [] = pedir todo. Si la API lo exige, cae a INCOME/OUTCOME
    limitsAprobar: [50, 25, 15],
    pausa: 120,
    pausaAgente: 2000,     // respiro entre agentes
    maxLotes: 40000,
    maxFilas: 800000,
  };

  const ENDPOINT = "/api/backoffice/v1/account-transfers/player";
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ── Token ──────────────────────────────────────────────────────────────────
  const leerToken = () => {
    try {
      const o = JSON.parse(localStorage.getItem("auth_token"));
      return o?.accessToken || (typeof o === "string" ? o : null);
    } catch {
      const a = window.__AUTH__;
      return a ? a.replace(/^Bearer\s+/i, "") : null;
    }
  };
  let token = leerToken();
  if (!token) return console.error("❌ No hay token. Recargá y logueate.");

  const payload = (() => {
    try { return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); }
    catch { return null; }
  })();
  const minutosToken = payload?.exp ? Math.round((payload.exp * 1000 - Date.now()) / 60000) : null;
  if (minutosToken !== null && minutosToken <= 0)
    return console.error("❌ Token VENCIDO. Recargá (Cmd+R) y volvé a pegar.");
  if (minutosToken !== null && minutosToken < 5)
    return console.error(`❌ Al token le quedan ${minutosToken} min — no alcanza. Recargá (Cmd+R) primero.`);
  if (minutosToken !== null && minutosToken < 20)
    console.warn(`⚠️ Al token le quedan ${minutosToken} min. Si se corta, ver instrucciones de renovación abajo.`);
  else if (minutosToken !== null)
    console.log(`🔑 Token válido por ~${minutosToken} min.`);

  const idLogueado = String(payload?.userId ?? payload?.id ?? payload?.sub ?? "");
  const AUTH_INICIAL = `Bearer ${token}`;

  // ── Descubrimiento de agentUserId por nombre (solo si id === null) ────────
  const ENDPOINTS_AGENTES = [
    q => `/api/backoffice/v1/users?role=AGENT&search=${q}&limit=50`,
    q => `/api/backoffice/v1/users?search=${q}&limit=50`,
    q => `/api/backoffice/v1/users/agent?search=${q}&limit=50`,
    q => `/api/backoffice/v1/agents?search=${q}&limit=50`,
    q => `/api/backoffice/v1/users/agents?search=${q}&limit=50`,
    q => `/api/backoffice/v1/users?username=${q}`,
    () => `/api/backoffice/v1/users/tree`,
    () => `/api/backoffice/v1/users/agent/tree`,
  ];

  const cosechar = (nodo, salida, visto) => {
    if (!nodo || typeof nodo !== "object") return;
    if (Array.isArray(nodo)) { for (const n of nodo) cosechar(n, salida, visto); return; }
    const uname = nodo.username ?? nodo.userName ?? nodo.login ?? null;
    const uid   = nodo.id ?? nodo.userId ?? nodo.userID ?? null;
    if (typeof uname === "string" && uname && uid != null && !visto.has(String(uid))) {
      visto.add(String(uid));
      salida.push({ id: String(uid), username: uname, rol: nodo.role ?? nodo.userRole ?? "" });
    }
    for (const v of Object.values(nodo)) cosechar(v, salida, visto);
  };

  const resolverAgente = async (username) => {
    const encontrados = [], visto = new Set();
    let endpointOk = null;
    for (const build of ENDPOINTS_AGENTES) {
      const u = build(encodeURIComponent(username));
      try {
        const r = await fetch(u, {
          credentials: "include",
          headers: { accept: "application/json", authorization: AUTH_INICIAL },
        });
        if (!r.ok) continue;
        const j = await r.json();
        const antes = encontrados.length;
        cosechar(j, encontrados, visto);
        if (encontrados.length > antes && !endpointOk) endpointOk = u.split("?")[0];
      } catch { /* candidato inválido, seguir */ }
    }
    if (endpointOk) console.log(`🛰️ Endpoint de agentes que respondió: ${endpointOk}`);
    if (encontrados.length) {
      console.log(`📋 ${encontrados.length} usuarios visibles (id → username):`);
      console.table(encontrados);
    }
    const hit = encontrados.find(e => e.username.toLowerCase() === username.toLowerCase());
    return hit ? hit.id : null;
  };

  // ── Helpers de fecha/número en el huso de CFG.tz ──────────────────────────
  const offMin = (() => {
    const m = /([+-])(\d{2}):(\d{2})/.exec(CFG.tz);
    return m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]) : 0;
  })();
  const shift   = ts => new Date(ts + offMin * 60000);
  const p2      = n => String(n).padStart(2, "0");
  const fechaDe = ts => { const d = shift(ts); return `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`; };
  const horaDe  = ts => { const d = shift(ts); return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`; };
  const hourOf  = ts => shift(ts).getUTCHours();

  const num = v => {
    if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
    let s = String(v ?? "").trim();
    if (!s) return 0;
    if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");  // AR
    else s = s.replace(/,/g, "");                                          // US / plano
    const n = parseFloat(s);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  };
  const r2  = n => Math.round(n * 100) / 100;
  const fmt = n => n.toLocaleString("es-AR", { minimumFractionDigits: 2 });

  // ── Meses ─────────────────────────────────────────────────────────────────
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

  // ── Request ───────────────────────────────────────────────────────────────
  let opsList = Array.isArray(CFG.operations) ? [...CFG.operations] : [];
  const buildUrl = (agId, desde, hasta, offset, limit) => {
    const p = new URLSearchParams();
    opsList.forEach(o => p.append("operations[]", o));
    p.set("agentUserId", agId);
    p.set("dateFrom", new Date(`${desde}T00:00:00${CFG.tz}`).toISOString());
    p.set("dateTo",   new Date(`${hasta}T00:00:00${CFG.tz}`).toISOString());
    p.set("offset", offset);
    p.set("limit", limit);
    return `${ENDPOINT}?${p}`;
  };
  let AUTH = null;
  const pedir = (agId, desde, hasta, off, lim, auth) => {
    let h = auth;
    const t = leerToken();
    if (t && t !== token) {
      token = t;
      h = AUTH = auth.startsWith("Bearer") ? `Bearer ${t}` : t;
      console.log("🔑 Token renovado desde localStorage — sigo.");
    }
    return fetch(buildUrl(agId, desde, hasta, off, lim), {
      credentials: "include",
      headers: { accept: "application/json", authorization: h },
    });
  };

  // ── Resolución de todos los agentes ───────────────────────────────────────
  const agentes = [];
  for (const a of CFG.agentes) {
    let id = a.id ? String(a.id) : null;
    if (!id) {
      console.log(`🔎 Buscando el ID de "${a.username}"…`);
      id = await resolverAgente(a.username);
      if (!id) {
        console.error(`❌ No pude resolver "${a.username}" — lo salteo. Buscá su ID en el panel y ponelo en CFG.`);
        continue;
      }
      console.log(`✅ ${a.username} → ${id}`);
    }
    agentes.push({ username: a.username || `agente_${id}`, id });
  }
  if (!agentes.length) return console.error("❌ Ningún agente resoluble. Revisá CFG.agentes.");

  console.log(
    `👥 ${agentes.length} agente(s): ${agentes.map(a => `${a.username}(${a.id})`).join(", ")}\n` +
    `📅 ${meses.length} meses: ${meses.map(x => x.etiqueta).join(", ")}\n` +
    `📄 ${agentes.length * meses.length} archivos a generar`
  );
  if (idLogueado) console.log(`ℹ️ Sesión logueada: ${idLogueado}. Cotejá cada agente contra el panel filtrado por ÉL.`);

  // ── Auth + límite (una sola vez, con el primer agente/mes) ────────────────
  const a0 = agentes[0], m0 = meses[0];
  for (const esq of [`Bearer ${token}`, token]) {
    let r = await pedir(a0.id, m0.desde, m0.hasta, 0, 1, esq);
    if (r.status === 400 && opsList.length === 0) {
      opsList = ["INCOME", "OUTCOME"];
      console.warn("⚠️ La API exige filtro de tipo → INCOME/OUTCOME. LOS BONOS NO ENTRAN.");
      r = await pedir(a0.id, m0.desde, m0.hasta, 0, 1, esq);
    }
    if (r.ok) { AUTH = esq; break; }
  }
  if (!AUTH) return console.error("❌ Auth rechazada. Recargá y logueate.");

  let LIM = null;
  for (const cand of CFG.limitsAprobar) {
    const r = await pedir(a0.id, m0.desde, m0.hasta, 0, cand, AUTH);
    if (r.ok) { LIM = cand; break; }
  }
  if (!LIM) return console.error("❌ Ningún limit aceptado.");
  console.log(`✅ Auth OK | 📦 limit ${LIM} | tipos: ${opsList.length ? opsList.join(",") : "TODOS"}`);

  // ── Manejo de 401 sin abortar ─────────────────────────────────────────────
  const ESPERA_TOKEN_MS = 180000;
  const esperarTokenNuevo = async (offset) => {
    const tokenViejo = token;
    console.warn(
      `🔑 401 en offset=${offset} — el token venció.\n` +
      `   → Abrí OTRA pestaña en admin.argenbet.net y recargala (NO cierres esta).\n` +
      `   → Retomo solo en cuanto detecte el token nuevo. Espero hasta ${ESPERA_TOKEN_MS / 60000} min.`
    );
    const limite = Date.now() + ESPERA_TOKEN_MS;
    while (Date.now() < limite) {
      await sleep(3000);
      const t = leerToken();
      if (t && t !== tokenViejo) {
        token = t;
        AUTH = AUTH.startsWith("Bearer") ? `Bearer ${t}` : t;
        console.log("✅ Token nuevo detectado — retomo.");
        return true;
      }
    }
    return false;
  };

  const getJSON = async (agId, desde, hasta, offset, intento = 0) => {
    const r = await pedir(agId, desde, hasta, offset, LIM, AUTH);
    if (r.status === 401 || r.status === 403) {
      if (intento >= 2) throw new Error(`HTTP ${r.status} persistente en offset=${offset}`);
      const ok = await esperarTokenNuevo(offset);
      if (!ok) throw new Error(`Token no renovado a tiempo (offset=${offset})`);
      return getJSON(agId, desde, hasta, offset, intento + 1);
    }
    if (r.status === 429) { await sleep(3000); return getJSON(agId, desde, hasta, offset, intento); }
    if (!r.ok) throw new Error(`HTTP ${r.status} en offset=${offset}`);
    return r.json();
  };

  // ── XLSX ──────────────────────────────────────────────────────────────────
  if (!window.XLSX) {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    }).catch(() => console.warn("⚠️ No se pudo cargar XLSX — se bajará CSV."));
  }
  const dl = (blob, fn) => {
    const u = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: u, download: fn });
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(u);
  };

  const hMov  = ["id", "fecha", "hora", "jugador", "jugadorId", "tipo", "monto", "iniciador", "saldoAntes", "saldoDespues", "operacion"];
  const hHora = ["franja", "cargasCant", "cargasMonto", "retirosCant", "retirosMonto", "bonosCant", "bonosMonto", "movTotal"];

  let camposVolcados = false;
  const resumenGeneral = [];

  // ── Loop: agente → mes ────────────────────────────────────────────────────
  for (const ag of agentes) {
    console.log(`\n╔═══ ${ag.username} (${ag.id}) ═══╗`);

    for (const mes of meses) {
      console.log(`\n══ ${ag.username} · ${mes.etiqueta} ── ${mes.desde} → ${mes.hasta} (exclusivo) ══`);

      const MOV = [], vistos = new Set();
      let offset = 0, lote = 0, ultimaFirma = "", dups = 0, sinId = 0;
      let incompleto = false, motivo = "";

      try {
        while (lote < CFG.maxLotes && MOV.length < CFG.maxFilas) {
          const data = await getJSON(ag.id, mes.desde, mes.hasta, offset);
          const items = Array.isArray(data) ? data : (data.items || data.data || data.rows || []);
          if (!items.length) break;

          if (!camposVolcados && items[0]) {
            camposVolcados = true;
            console.log("🔍 CAMPOS DEL ITEM CRUDO:", Object.keys(items[0]).join(", "));
            console.log("🔍 PRIMER ITEM COMPLETO:", items[0]);
          }

          const firma = JSON.stringify(items[0]);
          if (firma === ultimaFirma) { console.warn("⚠️ Lote repetido — la API ignora offset. Corto."); break; }
          ultimaFirma = firma;

          for (const it of items) {
            const id = it.id ?? it.transferId ?? it.transactionId ?? it.uuid ?? null;
            if (id == null) sinId++;

            let side;
            if (it.toUserRole === "player") side = "to";
            else if (it.fromUserRole === "player") side = "from";
            else if (String(it.toUserId) !== ag.id) side = "to";
            else side = "from";

            const ts = it.createdAt ? new Date(it.createdAt).getTime() : 0;
            const clave = id != null
              ? `id:${id}`
              : `s:${it.createdAt}|${it.amount}|${it[side + "Username"]}|${it.operation}`;
            if (vistos.has(clave)) { dups++; continue; }
            vistos.add(clave);

            const op = String(it.operation || "").toUpperCase();
            const tipo = /BON/.test(op) ? "Bono"
                       : op === "INCOME"  ? "Depósito"
                       : op === "OUTCOME" ? "Retiro"
                       : (it.operation || "?");

            MOV.push({
              ts,
              id: id ?? "",
              fecha: ts ? fechaDe(ts) : "",
              hora:  ts ? horaDe(ts)  : "",
              jugador:   it[side + "Username"] || "",
              jugadorId: String(it[side + "UserId"] ?? ""),
              tipo,
              monto: num(it.amount),
              iniciador: it.creatorUsername || "",
              saldoAntes:   num(it[side + "AccountBalance"]),
              saldoDespues: num(it[side + "AccountBalanceAfter"]),
              operacion: it.operation || "",
            });
          }

          offset += items.length;
          lote++;
          if (lote % 10 === 0) console.log(`   ⏳ ${MOV.length}…`);
          if (items.length < LIM) break;
          await sleep(CFG.pausa);
        }
      } catch (err) {
        incompleto = true;
        motivo = err.message;
        console.error(`   ❌ ${ag.username} ${mes.etiqueta} cortado en offset=${offset}: ${err.message}`);
        console.error(`      Guardo las ${MOV.length} filas obtenidas como PARCIAL y sigo.`);
      }

      if (!MOV.length) {
        console.warn(`   ⚠️ ${ag.username} ${mes.etiqueta}: 0 movimientos, no se genera archivo.`);
        resumenGeneral.push({ agente: ag.username, mes: mes.etiqueta, movs: 0, depositos: 0, retiros: 0, bonos: 0, estado: incompleto ? `FALLÓ: ${motivo}` : "vacío" });
        continue;
      }
      MOV.sort((a, b) => a.ts - b.ts);

      const T = { dep: 0, depN: 0, ret: 0, retN: 0, bon: 0, bonN: 0 };
      for (const m of MOV) {
        if (m.tipo === "Retiro")     { T.ret += m.monto; T.retN++; }
        else if (m.tipo === "Bono")  { T.bon += m.monto; T.bonN++; }
        else                         { T.dep += m.monto; T.depN++; }
      }

      const H = Array.from({ length: 24 }, () => ({ cargasCant:0, cargasMonto:0, retirosCant:0, retirosMonto:0, bonosCant:0, bonosMonto:0 }));
      for (const m of MOV) {
        const b = H[hourOf(m.ts)];
        if (m.tipo === "Retiro")    { b.retirosCant++; b.retirosMonto += m.monto; }
        else if (m.tipo === "Bono") { b.bonosCant++;   b.bonosMonto   += m.monto; }
        else                        { b.cargasCant++;  b.cargasMonto  += m.monto; }
      }
      const porHora = H.map((b, h) => ({
        franja: `${p2(h)}:00–${p2(h)}:59`,
        cargasCant: b.cargasCant,   cargasMonto: r2(b.cargasMonto),
        retirosCant: b.retirosCant, retirosMonto: r2(b.retirosMonto),
        bonosCant: b.bonosCant,     bonosMonto: r2(b.bonosMonto),
        movTotal: b.cargasCant + b.retirosCant + b.bonosCant,
      }));
      const tot = porHora.reduce((a, r) => { for (const k in a) if (k !== "franja") a[k] += r[k]; return a; },
        { franja:"TOTAL", cargasCant:0, cargasMonto:0, retirosCant:0, retirosMonto:0, bonosCant:0, bonosMonto:0, movTotal:0 });
      tot.cargasMonto = r2(tot.cargasMonto); tot.retirosMonto = r2(tot.retirosMonto); tot.bonosMonto = r2(tot.bonosMonto);
      porHora.push(tot);

      console.log(
        `   ✅ ${MOV.length} movs | Dep ${T.depN}: $${fmt(r2(T.dep))} | Ret ${T.retN}: $${fmt(r2(T.ret))}` +
        (T.bonN ? ` | Bonos ${T.bonN}: $${fmt(r2(T.bon))}` : "") +
        (dups ? ` | ${dups} duplicados descartados` : "") +
        (sinId ? ` | ⚠️ ${sinId} filas SIN id` : " | id presente en todas")
      );
      resumenGeneral.push({
        agente: ag.username, mes: mes.etiqueta, movs: MOV.length,
        depositos: r2(T.dep), retiros: r2(T.ret), bonos: r2(T.bon),
        estado: incompleto ? `PARCIAL (offset=${offset})` : "completo",
      });

      const rowsMov = MOV.map(({ ts, ...r }) => r);
      const base = `argenbet_${ag.username}_${mes.etiqueta}${incompleto ? "_PARCIAL" : ""}`;
      try {
        if (!window.XLSX) throw new Error("sin XLSX");
        const wb  = XLSX.utils.book_new();
        const ws1 = XLSX.utils.json_to_sheet(rowsMov, { header: hMov });
        ws1["!cols"] = [{wch:12},{wch:11},{wch:10},{wch:18},{wch:10},{wch:10},{wch:14},{wch:15},{wch:15},{wch:15},{wch:12}];
        ws1["!autofilter"] = { ref: XLSX.utils.encode_range({ s:{r:0,c:0}, e:{r:rowsMov.length, c:hMov.length-1} }) };
        XLSX.utils.book_append_sheet(wb, ws1, "Movimientos");
        const ws2 = XLSX.utils.json_to_sheet(porHora, { header: hHora });
        ws2["!cols"] = [{wch:13},{wch:12},{wch:14},{wch:12},{wch:14},{wch:11},{wch:13},{wch:11}];
        XLSX.utils.book_append_sheet(wb, ws2, "Por hora");
        dl(new Blob([XLSX.write(wb, { bookType:"xlsx", type:"array" })],
          { type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${base}.xlsx`);
        console.log(`   💾 ${base}.xlsx`);
      } catch {
        const esc = v => { const s = String(v ?? ""); return /[;"\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
        const csv = hMov.join(";") + "\n" + rowsMov.map(r => hMov.map(h => esc(r[h])).join(";")).join("\n");
        dl(new Blob(["﻿" + csv], { type:"text/csv;charset=utf-8;" }), `${base}.csv`);
        console.warn(`   💾 ${base}.csv (XLSX no disponible)`);
      }

      await sleep(500);
    }

    await sleep(CFG.pausaAgente);
  }

  console.log("\n═══ RESUMEN GENERAL ═══");
  console.table(resumenGeneral);
  const parciales = resumenGeneral.filter(r => String(r.estado).startsWith("PARCIAL") || String(r.estado).startsWith("FALLÓ"));
  if (parciales.length) console.warn(`⚠️ ${parciales.length} archivo(s) incompletos — rebajá esos meses de a uno.`);
  else console.log("✅ Todos los meses completos.");
})();
