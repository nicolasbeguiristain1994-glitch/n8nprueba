# Guía — Exportar movimientos de Ganamos y Argenbet desde la consola del navegador

> **Para quién:** la persona que baja los Excel mensuales de cargas y retiros de cada agente.
> No hace falta saber programar: los scripts se pegan en la consola del navegador y descargan
> los archivos solos. Lo único que se edita es el bloque `CFG` al principio de cada script.
>
> **Última revisión:** 2026-09-16. Los scripts vienen con placeholders (`USUARIO_AGENTE`,
> `ID_AGENTE`) que hay que reemplazar por los datos de los agentes propios antes de correrlos.

---

## 1. Resumen: qué script usar

| Plataforma | Script | Qué genera | Cuándo usarlo |
|---|---|---|---|
| **Argenbet** | Exportador Argenbet (§3) | Un XLSX por agente y por mes, con movimientos y resumen por hora | Siempre. Es el único script de Argenbet. |
| **Ganamos** | Exportador mensual (§4.3) | Un XLSX por mes con totales del panel + detalle por jugador (si existe) | El habitual. Cubre todo lo que se necesita del mes. |
| **Ganamos** | Totales históricos (§4.4) | Un XLSX por mes solo con la serie diaria de depósitos y retiros | Para meses viejos (más de 60 días), donde no hay detalle por jugador y se quiere ir rápido. |
| **Ganamos** | Exportador por rango (§4.5) | Un único XLSX con Jugadores + Movimientos de todo un rango | Para un análisis de varios meses juntos sobre la ventana reciente. |

Diferencia clave entre plataformas:

- **Argenbet:** se entra con la cuenta de administrador y con esa sola sesión se bajan todos los agentes. El histórico completo está disponible.
- **Ganamos:** hay que entrar **con la cuenta de cada agente**, uno por vez. Y el detalle por jugador (quién cargó, cuánto, a qué hora) **solo existe para los últimos ~60 días**. Los totales diarios sí están para todo el histórico.

---

## 2. Requisitos y pasos comunes

1. Usar Chrome (o Edge/Brave) en una computadora. No funciona desde el celular.
2. Entrar al panel y loguearse normalmente.
3. Abrir la consola: `F12` (o `Cmd+Option+J` en Mac) y elegir la pestaña **Console**.
4. La primera vez, Chrome bloquea el pegado y pide escribir `allow pasting`. Escribirlo, Enter, y recién ahí pegar.
5. Copiar el script **completo** (desde `/**` hasta `})();`), editar el bloque `CFG`, pegarlo en la consola y apretar Enter.
6. Cuando el navegador pregunte si permite **descargas múltiples** del sitio, aceptar. Si no, solo baja el primer archivo.
7. **No cerrar la pestaña ni navegar a otra página** hasta que aparezca el resumen final en la consola. Se puede minimizar el navegador, pero conviene dejar la pestaña visible: Chrome frena las pestañas que están en segundo plano y la corrida se alarga.
8. Los archivos se descargan a la carpeta de descargas del navegador. Nombre de archivo: `argenbet_<agente>_<AAAA-MM>.xlsx` o `ganamos_<agente>_<AAAA-MM>.xlsx`.

Todos los importes salen en **pesos con dos decimales** y todas las fechas y horas están en **hora argentina** (UTC-3).

---

## 3. Argenbet

### 3.1 Datos fijos

- **Panel:** `https://admin.argenbet.net`, logueado con la cuenta de administrador.
- **Agentes:** cada agente se identifica por su nombre de usuario y su `id` numérico. Con una sola sesión de administrador se pueden bajar todos.
- **Token:** Argenbet usa un token corto que vence seguido (suele durar menos de una hora). El script lo lee solo, avisa cuánto le queda y, si vence a mitad de la corrida, sabe recuperarse (ver §3.4).

**Cómo obtener el `id` de un agente:** en el panel, ir a **Transactions → Player**, filtrar por el agente y aplicar. En la pestaña **Network** de las herramientas del navegador aparece una request a `account-transfers/player`; en su URL está el parámetro `agentUserId=...`. Ese número es el `id`. Si no se conoce, se puede dejar `id: null` y el script intenta buscarlo por nombre, aunque no siempre lo logra.

### 3.2 Qué editar en `CFG`

```js
agentes: [
  { username: "USUARIO_AGENTE", id: "ID_AGENTE" },
  // { username: "OTRO_AGENTE",  id: null },   // id null = buscar por nombre
],
desde: "2026-03-01",   // primer mes a bajar (inclusive)
hasta: "2026-09-01",   // EXCLUSIVO: con 2026-09-01 el último mes que baja es agosto
```

- Para bajar varios agentes en una sola corrida, agregar un objeto por agente en la lista.
- `hasta` es **exclusivo**. Para bajar solo agosto 2026: `desde: "2026-08-01"`, `hasta: "2026-09-01"`.
- El resto de `CFG` no hace falta tocarlo.

### 3.3 Qué genera

Un archivo por agente y por mes: `argenbet_<agente>_<AAAA-MM>.xlsx`, con dos hojas:

- **Movimientos:** una fila por transacción. Columnas: `id`, `fecha`, `hora`, `jugador`, `jugadorId`, `tipo` (Depósito / Retiro / Bono), `monto`, `iniciador` (quién la hizo), `saldoAntes`, `saldoDespues`, `operacion` (el código crudo de la API).
- **Por hora:** cantidad y monto de cargas, retiros y bonos por franja horaria, con fila TOTAL al final.

Al terminar, la consola muestra una tabla **RESUMEN GENERAL** con movimientos, depósitos, retiros y estado (`completo`, `PARCIAL` o `FALLÓ`) por agente y mes.

Si el archivo se llama `..._PARCIAL.xlsx`, ese mes quedó incompleto: rebajarlo solo (un mes en `desde`/`hasta`) con el token recién renovado.

### 3.4 Si el token vence en el medio

El script avisa en la consola:

```
🔑 401 en offset=... — el token venció.
   → Abrí OTRA pestaña en admin.argenbet.net y recargala (NO cierres esta).
```

Hacer exactamente eso: abrir una pestaña nueva del panel, recargarla (si pide login, loguearse), y volver a la pestaña del script. El script detecta el token nuevo y sigue solo. Espera hasta 3 minutos; si no llega, guarda el mes como PARCIAL y pasa al siguiente.

Antes de arrancar, si la consola dice que al token le quedan menos de 5 minutos, recargar la página (`Cmd+R`), esperar a que cargue, y volver a pegar el script.

### 3.5 Cómo verificar que el archivo está bien

En el panel, ir a **Transactions → Player**, filtrar por el agente y por el mes, y comparar la cantidad de movimientos y los totales de depósitos y retiros con la fila TOTAL de la hoja "Por hora". Tienen que coincidir exacto, con centavos. Si no coinciden, el mes quedó incompleto: rebajarlo solo.

Si la consola muestra el aviso `LOS BONOS NO ENTRAN`, la API obligó a filtrar por depósito/retiro y los bonos no están en el archivo. Es el comportamiento normal hoy.

### 3.6 Script completo — Exportador Argenbet

```js
/**
 * Argenbet — exportador de movimientos por agente (consola del navegador).
 *
 * Uso: abrir admin.argenbet.net logueado, F12 -> Console, pegar y Enter.
 *
 * Baja un XLSX por agente y por mes calendario. Acepta varios agentes en una
 * sola corrida (CFG.agentes). Si a un agente no se le pasa `id`, lo busca por
 * nombre probando endpoints del backoffice; si falla, lo saltea y sigue.
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
    // Un objeto por agente. Agregá tantos como necesites.
    agentes: [
      { username: "USUARIO_AGENTE", id: "ID_AGENTE" },
      // { username: "OTRO_AGENTE",  id: null },   // id null = buscar por nombre
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
```

---

## 4. Ganamos

### 4.1 Datos fijos

- **Panel:** `https://agents.ganamosnet.org`.
- **Sesión:** hay que estar logueado **con la cuenta del agente que se quiere exportar**. Desde la cuenta de administrador el panel devuelve solo una fracción mínima de los movimientos de cada agente. No es un error del script, es cómo responde Ganamos.
- **Un agente por corrida.** Para exportar otro agente: cerrar sesión, entrar con la otra cuenta, cambiar `AGENT_USER` y volver a pegar.
- **Sin token:** la sesión va por cookie, no hay nada que renovar. Si la sesión se cae, el script corta y avisa; hay que loguearse de nuevo y volver a correr.

**Cómo obtener el `id` de un agente:** logueado con la cuenta del agente, ir a **Reportes financieros → Depósitos/Retiros Jugadores**, elegir un rango corto y aplicar el filtro. En la pestaña **Network** de las herramientas del navegador aparece una request cuya URL contiene `/api/agent_admin/user/<número>/payment/history/`. Ese número es el `id`. Conviene anotar en una tabla propia el usuario y el `id` de cada agente, y cargarlos en el bloque `IDS` de los scripts.

### 4.2 Los dos niveles de dato de Ganamos

Ganamos guarda dos cosas distintas y el script las combina:

| Nivel | Qué tiene | Hasta cuándo |
|---|---|---|
| **Totales diarios** | Depósitos y retiros por día del agente. Es lo que el panel muestra como "Balance actual". | Todo el histórico. |
| **Detalle transaccional** | Cada movimiento: jugador, hora, monto, quién lo inició. | Solo los **últimos ~60 días**. Antes de eso el panel mismo dice "0 registros". |

Consecuencias prácticas:

- **Los totales del mes siempre salen bien**, aunque el mes sea viejo.
- **El análisis por jugador solo existe para los últimos dos meses.** Lo que sale de la ventana de 60 días se pierde para siempre. Por eso conviene exportar **todos los meses, cada mes**, y no dejar acumular.
- El script calcula una **cobertura**: qué porcentaje de las cargas del panel explica el detalle. Si es menor al 95 %, marca el archivo como `DETALLE-PARCIAL`. Si no hay detalle, lo marca `SOLO-TOTALES`.

### 4.3 Script principal — Exportador mensual

**Qué editar:**

```js
const IDS = {
  // usuario: id numérico
  USUARIO_AGENTE: 0,
};

AGENT_USER: "USUARIO_AGENTE",    // ← EL AGENTE CON EL QUE ESTÁS LOGUEADO
MESES: ["2026-04"],              // uno o varios: ["2026-03","2026-04"]
```

En `IDS` se cargan todos los agentes propios con su `id` (uno por línea). En `AGENT_USER` va el usuario con el que se está logueado; el `id` lo toma de `IDS`.

**Cómo corre:** primero hace un chequeo de sesión. Si el servidor responde que la sesión no corresponde a ese agente, corta y lo dice; hay que corregir `AGENT_USER` (el usuario que figura arriba a la derecha del panel). Después recorre el mes **día por día** (Ganamos no acepta rangos más largos de forma confiable) pidiendo totales y detalle de cada día. Tarda unos minutos por mes.

**Qué genera:** un archivo por mes, `ganamos_<agente>_<AAAA-MM>.xlsx`, con estas hojas:

| Hoja | Contenido | ¿Siempre? |
|---|---|---|
| **Resumen** | Totales del mes, neto, % de retiro, día de mayor carga, cobertura del detalle y, si hay detalle, métricas de jugadores (únicos, ticket promedio, concentración top 10, activos / tibios / en riesgo) | Sí |
| **Por día** | Cargas, retiros y neto de cada día del mes (dato oficial del panel) más movimientos y jugadores del detalle | Sí |
| **Por día semana** | Lo mismo agrupado por lunes, martes, etc. | Sí |
| **Jugadores** | Una fila por jugador: cargas, retiros, neto, promedio, mediana, días activos, franja y día habitual, última carga, segmento (`super_vip` / `vip` / `medio` / `bajo`) y actividad (`activo` / `tibio` / `en_riesgo` / `inactivo`) | Solo con detalle |
| **Movimientos** | Una fila por transacción | Solo con detalle |
| **Por hora** | Cargas y retiros por franja horaria | Solo con detalle |

Sufijos del nombre de archivo:

- `_SOLO-TOTALES`: mes fuera de la ventana de 60 días. Tiene totales, no jugadores.
- `_DETALLE-PARCIAL`: hay detalle pero cubre menos del 95 % de las cargas. Típico del mes en que cae el corte de 60 días.
- `_CON-FALLAS`: alguna consulta diaria falló después de 3 reintentos. La consola muestra qué días. Rebajar ese mes.

**Cómo verificar:** en el panel, **Reportes financieros → Depósitos/Retiros Jugadores**, filtrar el mes y comparar el "Balance actual" de depósitos y retiros con la fila TOTAL de la hoja "Por día". Deben coincidir exacto.

**Script completo:**

```js
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
    // usuario: id numérico (cómo obtenerlo: ver la guía)
    USUARIO_AGENTE: 0,
  };

  const CFG = {
    AGENT_USER: "USUARIO_AGENTE",    // ← EL AGENTE CON EL QUE ESTÁS LOGUEADO
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
```

### 4.4 Solo totales históricos

Para cuando se quiere la serie diaria de varios meses viejos y no interesa el detalle. Es más liviano: una consulta por día en vez de dos.

**Qué editar:**

```js
const IDS = {
  USUARIO_AGENTE: "0",   // usuario: id numérico, entre comillas
};

agente: "USUARIO_AGENTE",   // ← el agente con el que estás logueado
desde: "2026-03-01",
hasta: "2026-09-01",        // exclusivo
```

**Qué genera:** un archivo por mes, `ganamos_TOTALES_<agente>_<AAAA-MM>.xlsx`, con una sola hoja "Por día" (fecha, depósitos, retiros, neto y fila TOTAL). Al final imprime en la consola una tabla con los totales de cada mes.

**Script completo:**

```js
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
    // usuario: id numérico (cómo obtenerlo: ver la guía)
    USUARIO_AGENTE: "0",
  };

  const CFG = {
    agente: "USUARIO_AGENTE",   // ← el agente con el que estás logueado
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
})();
```

### 4.5 Un solo archivo por rango

Para juntar varios meses de la ventana reciente en un único Excel con dos hojas (Jugadores y Movimientos). No trae los totales del panel: si el rango incluye meses fuera de los 60 días, esos vienen vacíos.

**Qué editar:**

```js
AGENT_ID: 0,                    // ← id numérico del agente
AGENT_USER: "USUARIO_AGENTE",
FECHA_INICIO: "2026-03-01",
FECHA_FIN: "2026-08-31",        // inclusive
```

Acá el `AGENT_ID` se pone a mano y `FECHA_FIN` es **inclusivo**, al revés que en los otros scripts.

**Script completo:**

```js
/**
 * Ganamos — exportador de movimientos por rango.
 * Un único XLSX con hojas Jugadores + Movimientos.
 *
 * ⚠️ Correr LOGUEADO CON LA CUENTA DEL AGENTE (no la de admin).
 * Nota: el detalle transaccional solo está disponible para la ventana reciente
 * (~60 días); los meses anteriores devuelven listas vacías.
 */
(async () => {
  const CONFIG = {
    AGENT_ID: 0,               // ← id numérico del agente
    AGENT_USER: "USUARIO_AGENTE",
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
```

---

## 5. Problemas frecuentes

| Síntoma | Causa | Qué hacer |
|---|---|---|
| Chrome no deja pegar en la consola | Protección anti-pegado | Escribir `allow pasting`, Enter, y pegar de nuevo. |
| Baja el primer archivo y los demás no | Descargas múltiples bloqueadas | Aceptar el aviso del navegador (ícono en la barra de direcciones) y volver a correr. |
| `No tengo el ID de "USUARIO_AGENTE"` o `Sin id` | No se completó el bloque `IDS` / `CFG` | Reemplazar los placeholders por el usuario y el `id` reales (ver §3.1 y §4.1). |
| Argenbet: `Token VENCIDO` o `le quedan N min` antes de arrancar | Token corto | Recargar la página, esperar a que cargue el panel, pegar de nuevo. |
| Argenbet: se frena con `401 en offset=...` | Token vencido a mitad de corrida | Abrir otra pestaña del panel y recargarla. No cerrar la del script. Retoma solo. |
| Ganamos: `La sesión abierta no corresponde a ese agente` | `AGENT_USER` no coincide con el usuario logueado | Poner en `AGENT_USER` el usuario que figura arriba a la derecha del panel. |
| Ganamos: el mes sale `_SOLO-TOTALES` | El mes tiene más de 60 días | Es normal. El detalle por jugador de ese mes ya no existe en Ganamos. |
| Ganamos: totales del mes muy bajos comparados con el panel | Sesión de administrador en vez de la del agente | Cerrar sesión y entrar con la cuenta del agente. |
| Ganamos: `HTTP 500` o `statement timeout` en algunos días | El backend no aguanta el día entero | El script reintenta y parte el día en franjas de 6 h solo. Si igual falla, el archivo sale `_CON-FALLAS` con los días listados: rebajar ese mes. |
| La corrida tarda mucho más de lo estimado | Pestaña en segundo plano | Traer la pestaña al frente. Chrome frena las pestañas ocultas. |
| Sale un `.csv` en vez de `.xlsx` | No se pudo cargar la librería de Excel | El archivo es igual de válido; abrirlo con Excel con separador `;`. |

---

## 6. Después de exportar

Guardar los Excel con el nombre que genera el script, sin renombrar, porque el nombre indica agente, mes y si el archivo quedó parcial.
