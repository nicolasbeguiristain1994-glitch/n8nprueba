BEGIN;

-- ── Agrega REACTIVACION_FRIA_ALTO_VALOR al constraint de reactivation_segment ─
--
-- Este segmento cubre contactos VIP/ALTO con 4–6 meses de inactividad.
-- Requiere una estrategia de win-back agresiva (oferta máxima).
-- Lógica: su LTV histórico justifica el intento incluso a esa antigüedad.

-- PostgreSQL no permite modificar CHECK inline — hay que drop + recrear.
ALTER TABLE contact_priority_scores
  DROP CONSTRAINT IF EXISTS contact_priority_scores_reactivation_segment_check;

ALTER TABLE contact_priority_scores
  ADD CONSTRAINT contact_priority_scores_reactivation_segment_check
  CHECK (reactivation_segment IN (
    'REACTIVACION_URGENTE',
    'REACTIVACION_PRIORITARIA',
    'REACTIVACION_ESTANDAR',
    'REACTIVACION_FRIA_ALTO_VALOR',
    'REACTIVACION_FRIA'
  ));

-- Índice actualizado: incluye el nuevo segmento (el índice parcial existente
-- ya cubre todo por ser sobre (reactivation_segment, priority_score DESC),
-- así que solo necesitamos confirmar que idx_cps_segment_score sigue válido).
-- No requiere acción adicional — el índice sobre text no tiene list de valores.

COMMIT;
