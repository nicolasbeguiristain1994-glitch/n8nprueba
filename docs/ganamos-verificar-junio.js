/**
 * Ganamos — ¿hasta dónde llega el histórico de payment/history?
 *
 * Correr LOGUEADO COMO adminfara (o el agente que sea; cambiar AGENT_ID).
 *
 * Hipótesis: el endpoint solo conserva los últimos ~60 días. Evidencia: hoy
 * 2026-09-08, el primer día con datos fue 2026-07-09 (61 días atrás), agosto
 * vino completo y marzo-junio vacíos — pese a que el agente sí operó esos meses.
 *
 * Este script barre día por día un tramo alrededor del supuesto corte y reporta
 * el primer día con movimientos. Si ese día es (hoy - ~60), queda confirmado que
 * es una ventana deslizante del backend y no un problema del exportador.
 */
(async () => {
  const AGENT_ID = "24050926";        // adminfara
  const DESDE    = "2026-06-01";      // arranca bien antes del supuesto corte
  const HASTA    = "2026-07-20";      // y termina bien después

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const addDays = (iso, n) => { const [y,m,d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m-1, d+n)).toISOString().slice(0,10); };
  const hoy = new Date().toISOString().slice(0, 10);
  const diasEntre = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000);

  const base = {
    username: "", role: "0",
    is_direct_structure: "false",
    is_higher_transaction_only: "false",
    is_withdrawal_transfers: "true",
    is_deposit_transfers: "true",
    is_bonus_deposits: "false",
    transfers_only: "true",    // true = filas; false = solo totales del período
  };

  const contarDia = async (dia) => {
    const p = new URLSearchParams({ ...base,
      date_from: `${dia}T00:00:00`, date_to: `${addDays(dia,1)}T00:00:00`,
      page: "0", count: "500" });
    const r = await fetch(`/api/agent_admin/user/${AGENT_ID}/payment/history/?${p}`,
      { credentials: "include", headers: { accept: "application/json" } });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    if (j.status !== 0) return { error: `API ${j.status}: ${j.error_message ?? ""}` };
    return { n: (j.result?.transfers ?? []).length };
  };

  console.log(`📅 Hoy: ${hoy}. Barriendo ${DESDE} → ${HASTA} día por día…\n`);
  const filas = [];
  let primerDiaConDatos = null;

  for (let d = DESDE; d <= HASTA; d = addDays(d, 1)) {
    const r = await contarDia(d);
    const antiguedad = diasEntre(d, hoy);
    filas.push({ dia: d, diasAtras: antiguedad, movimientos: r.error ?? r.n });
    if (!primerDiaConDatos && !r.error && r.n > 0) {
      primerDiaConDatos = d;
      console.log(`✔ Primer día con datos: ${d}  (${antiguedad} días atrás)`);
    }
    await sleep(120);
  }

  console.table(filas);

  if (!primerDiaConDatos) {
    console.warn("⚠️ Ningún día del tramo trajo datos. Ampliá el rango o revisá la sesión.");
    return;
  }

  const ventana = diasEntre(primerDiaConDatos, hoy);
  console.log(`\n═══ CONCLUSIÓN ═══`);
  console.log(`Primer día con movimientos: ${primerDiaConDatos} (${ventana} días antes de hoy).`);
  if (ventana >= 55 && ventana <= 95) {
    console.log(
      `✅ Coincide con una ventana de retención de ~${ventana} días.\n` +
      `   El backend NO expone historial más viejo por este endpoint. No es un bug del exportador.\n` +
      `   Para meses anteriores hay que buscar otra fuente (Informe General / Historial de jugadores)\n` +
      `   o exportar cada mes ANTES de que se caiga de la ventana.`
    );
  } else {
    console.log(
      `🤔 ${ventana} días no se parece a una ventana estándar. Puede ser la fecha real de alta del\n` +
      `   agente. Verificalo en el panel: filtrá un día anterior a ${primerDiaConDatos} y tocá\n` +
      `   "Cargar Operaciones" — si el panel muestra filas, el dato existe y falta el endpoint correcto.`
    );
  }
  console.log(
    `\n👉 Prueba complementaria en el panel: rango de junio + "Cargar Operaciones".\n` +
    `   Si el panel SÍ lista operaciones de junio, hay otro endpoint con más historial.\n` +
    `   Si el panel tampoco las muestra, la limitación es del backend y no hay vuelta.`
  );
})();
