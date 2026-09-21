/**
 * Ganamos — diagnóstico. No descarga nada.
 *
 * Responde dos cosas:
 *   A) Por qué /user/search/ no resuelve 4 de los 6 agentes (muestra la respuesta
 *      cruda y cosecha recursivamente todos los {id, username} que haya adentro).
 *   B) Si los "pocos movimientos" de adminzeus son reales o un parámetro que filtra
 *      de más: corre el mismo mes con distintas combinaciones y compara conteos,
 *      usando adminroyal como control (ese agente ya se validó contra el panel).
 */
(async () => {
  const MES = { desde: "2026-05-01", hasta: "2026-06-01" };   // mes a diagnosticar
  const NOMBRES = ["adminbtc", "adminzeus", "adminroyal", "admbigwin", "amdfarabet", "adminimperio"];
  const CONTROL = { adminzeus: "23851856", adminroyal: "24044323" };

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const get = async (url) => {
    const r = await fetch(url, { credentials: "include", headers: { accept: "application/json" } });
    return { status: r.status, json: r.ok ? await r.json().catch(() => null) : null };
  };

  // Recolecta cualquier {id, username} sin importar cómo venga anidado
  const cosechar = (n, out = [], visto = new Set()) => {
    if (!n || typeof n !== "object") return out;
    if (Array.isArray(n)) { for (const x of n) cosechar(x, out, visto); return out; }
    const u = n.username ?? n.userName ?? n.login;
    const i = n.id ?? n.userId;
    if (typeof u === "string" && u && i != null && !visto.has(String(i))) {
      visto.add(String(i));
      out.push({ id: String(i), username: u, role: String(n.role ?? ""), soloJugadores: n.can_create_only_player ?? "" });
    }
    for (const v of Object.values(n)) cosechar(v, out, visto);
    return out;
  };

  // ── A) Búsqueda de agentes ────────────────────────────────────────────────
  console.log("╔═══ A) RESOLUCIÓN DE AGENTES ═══╗");
  const hallazgos = [];
  for (const nombre of NOMBRES) {
    const url = `/api/agent_admin/user/search/?username=${encodeURIComponent(nombre)}&is_direct_structure=false`;
    const { status, json } = await get(url);
    if (status !== 200) { console.log(`\n▸ ${nombre}: HTTP ${status}`); continue; }

    const cosechados = cosechar(json);
    const exacto = cosechados.find(c => c.username.toLowerCase() === nombre.toLowerCase());
    console.log(`\n▸ ${nombre} → ${cosechados.length} usuario(s); exacto: ${exacto ? exacto.id : "NINGUNO"}`);
    console.log("   forma cruda de la respuesta:", Array.isArray(json) ? "(array)" : `objeto {${Object.keys(json ?? {}).join(", ")}}`);
    if (cosechados.length) console.table(cosechados);
    else console.log("   respuesta:", json);
    hallazgos.push({ nombre, encontrados: cosechados.length, idExacto: exacto?.id ?? "—" });
    await sleep(250);
  }
  console.log("\nResumen de la búsqueda:");
  console.table(hallazgos);

  // ── B) Variantes de parámetros ────────────────────────────────────────────
  const base = {
    username: "", role: "0",
    is_direct_structure: "false",
    is_higher_transaction_only: "false",
    is_withdrawal_transfers: "true",
    is_deposit_transfers: "true",
    is_bonus_deposits: "false",
    transfers_only: "true",
  };

  const contar = async (agId, desde, hasta, extra = {}, maxPag = 20) => {
    let total = 0, paginas = 0, primer = null;
    for (let page = 0; page < maxPag; page++) {
      const p = new URLSearchParams({
        ...base, ...extra,
        date_from: `${desde}T00:00:00`, date_to: `${hasta}T00:00:00`,
        page: String(page), count: "500",
      });
      const r = await fetch(`/api/agent_admin/user/${agId}/payment/history/?${p}`,
        { credentials: "include", headers: { accept: "application/json" } });
      if (!r.ok) return { total: `HTTP ${r.status}`, paginas, primer };
      const j = await r.json();
      if (j.status !== 0) return { total: `API ${j.status}: ${j.error_message ?? ""}`, paginas, primer };
      const arr = j.result?.transfers ?? [];
      if (!primer && arr[0]) primer = arr[0];
      total += arr.length; paginas++;
      if (arr.length < 500) break;
      await sleep(150);
    }
    return { total, paginas, primer };
  };

  const VARIANTES = [
    { etiqueta: "base (lo que usa el script)",   extra: {} },
    { etiqueta: "is_direct_structure=true",      extra: { is_direct_structure: "true" } },
    { etiqueta: "transfers_only=false",          extra: { transfers_only: "false" } },
    { etiqueta: "is_higher_transaction_only=true", extra: { is_higher_transaction_only: "true" } },
    { etiqueta: "is_bonus_deposits=true",        extra: { is_bonus_deposits: "true" } },
    { etiqueta: "sin role",                      extra: { role: "" } },
  ];

  console.log(`\n╔═══ B) VARIANTES SOBRE ${MES.desde} → ${MES.hasta} ═══╗`);
  for (const [nombre, id] of Object.entries(CONTROL)) {
    console.log(`\n▸▸ ${nombre} (${id})`);
    const filas = [];
    for (const v of VARIANTES) {
      const { total, paginas } = await contar(id, MES.desde, MES.hasta, v.extra);
      filas.push({ variante: v.etiqueta, filas: total, paginas });
      await sleep(300);
    }
    console.table(filas);
  }

  // Mes entero de una vs día por día — detecta truncado por rango largo
  console.log("\n╔═══ MES ENTERO vs DÍA POR DÍA ═══╗");
  const addDays = (iso, n) => { const [y,m,d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m-1, d+n)).toISOString().slice(0,10); };
  for (const [nombre, id] of Object.entries(CONTROL)) {
    const entero = await contar(id, MES.desde, MES.hasta);
    let porDia = 0;
    const ids = new Set();
    for (let d = MES.desde; d < MES.hasta; d = addDays(d, 1)) {
      const p = new URLSearchParams({ ...base, date_from: `${d}T00:00:00`, date_to: `${addDays(d,1)}T00:00:00`, page: "0", count: "500" });
      const r = await fetch(`/api/agent_admin/user/${id}/payment/history/?${p}`, { credentials: "include", headers: { accept: "application/json" } });
      if (!r.ok) continue;
      const j = await r.json();
      for (const t of (j.result?.transfers ?? [])) { if (!ids.has(t.id)) { ids.add(t.id); porDia++; } }
      await sleep(120);
    }
    console.log(`${nombre}: mes entero = ${entero.total} | día por día (únicos) = ${porDia}` +
      (String(entero.total) === String(porDia) ? "  ✅ coinciden" : "  ⚠️ NO coinciden"));
    if (entero.primer) console.log("   ejemplo de fila:", entero.primer);
  }

  console.log("\n📋 Copiá todo. Con esto sé si es un parámetro o si adminzeus simplemente tiene poca actividad.");
})();
