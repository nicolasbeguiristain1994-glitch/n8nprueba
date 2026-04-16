#!/usr/bin/env bash
# =============================================================
# init-lines.sh — Inicializa las 30 instancias de Evolution API
# =============================================================
# Uso:
#   EVOLUTION_URL=http://localhost:8080 \
#   EVOLUTION_API_KEY=your-key \
#   bash scripts/ops/init-lines.sh
#
# Opciones:
#   --dry-run       Muestra qué haría sin ejecutar nada
#   --from N        Empieza desde la línea N (default: 1)
#   --to N          Termina en la línea N (default: 30)
#   --delete-first  Elimina la instancia si ya existe antes de crearla
# =============================================================

set -euo pipefail

EVOLUTION_URL="${EVOLUTION_URL:-http://localhost:8080}"
EVOLUTION_API_KEY="${EVOLUTION_API_KEY:-}"
DRY_RUN=false
FROM_LINE=1
TO_LINE=30
DELETE_FIRST=false

# ── Parse args ──────────────────────────────────────────────
for arg in "$@"; do
  case $arg in
    --dry-run)       DRY_RUN=true ;;
    --delete-first)  DELETE_FIRST=true ;;
    --from=*)        FROM_LINE="${arg#*=}" ;;
    --to=*)          TO_LINE="${arg#*=}" ;;
  esac
done

# ── Validaciones ─────────────────────────────────────────────
if [[ -z "$EVOLUTION_API_KEY" ]]; then
  echo "ERROR: EVOLUTION_API_KEY no está definida."
  echo "       Exportá la variable antes de correr el script."
  exit 1
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo "⚠️  DRY RUN — no se ejecutará ninguna llamada real."
fi

echo ""
echo "════════════════════════════════════════════════"
echo "  WhatsApp Line Pool — Init Script"
echo "  URL:    $EVOLUTION_URL"
echo "  Líneas: $FROM_LINE → $TO_LINE"
echo "════════════════════════════════════════════════"
echo ""

SUCCESS=0
SKIPPED=0
FAILED=0

for i in $(seq -w "$FROM_LINE" "$TO_LINE"); do
  INSTANCE_NAME="wa-instance-${i}"
  DISPLAY_NAME="Línea ${i}"

  echo -n "  [line_${i}] ${INSTANCE_NAME} → "

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "SKIP (dry-run)"
    continue
  fi

  # ── Borrar instancia existente si se pidió ───────────────
  if [[ "$DELETE_FIRST" == "true" ]]; then
    curl -s -o /dev/null -X DELETE \
      "${EVOLUTION_URL}/instance/delete/${INSTANCE_NAME}" \
      -H "apikey: ${EVOLUTION_API_KEY}" || true
    sleep 0.5
  fi

  # ── Crear instancia ──────────────────────────────────────
  HTTP_STATUS=$(curl -s -o /tmp/evolution_response.json -w "%{http_code}" \
    -X POST "${EVOLUTION_URL}/instance/create" \
    -H "apikey: ${EVOLUTION_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{
      \"instanceName\": \"${INSTANCE_NAME}\",
      \"qrcode\": true,
      \"integration\": \"WHATSAPP-BAILEYS\",
      \"rejectCall\": false,
      \"msgCall\": \"\",
      \"groupsIgnore\": true,
      \"alwaysOnline\": false,
      \"readMessages\": false,
      \"readStatus\": false
    }")

  if [[ "$HTTP_STATUS" == "201" || "$HTTP_STATUS" == "200" ]]; then
    QR_URL=$(python3 -c "import json,sys; d=json.load(open('/tmp/evolution_response.json')); print(d.get('qrcode',{}).get('base64','')[:30]+'...' if d.get('qrcode') else 'no-qr')" 2>/dev/null || echo "created")
    echo "OK (HTTP ${HTTP_STATUS}) — QR: ${QR_URL}"
    ((SUCCESS++))
  elif [[ "$HTTP_STATUS" == "409" ]]; then
    echo "ALREADY EXISTS — omitiendo (usa --delete-first para recrear)"
    ((SKIPPED++))
  else
    echo "ERROR (HTTP ${HTTP_STATUS})"
    cat /tmp/evolution_response.json 2>/dev/null || true
    ((FAILED++))
  fi

  # Delay entre creaciones para no saturar la API
  sleep 1
done

echo ""
echo "════════════════════════════════════════════════"
echo "  Resultado:"
echo "  ✅ Creadas:  ${SUCCESS}"
echo "  ⏭️  Omitidas: ${SKIPPED}"
echo "  ❌ Fallidas: ${FAILED}"
echo "════════════════════════════════════════════════"
echo ""
echo "Próximos pasos:"
echo "  1. Ir a Evolution API UI o llamar GET /instance/fetchInstances"
echo "  2. Vincular cada línea escaneando su QR"
echo "  3. Ejecutar la migración DB: psql \$DATABASE_URL < db/migrations/001_whatsapp_lines.sql"
echo "  4. Activar WF-013 (Line Health Monitor) en n8n para que detecte el estado de conexión"
echo ""
