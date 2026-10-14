# Prioridades: nivel comercial y ranking separado — 14/10/2026

Cambio solicitado: aplicar en producción las cuatro recomendaciones de la auditoría del módulo de prioridades.

- El nivel, puntaje base, ventana y cooldown usan la misma clasificación monetaria
  de Contactos, incluyendo la asignación manual. El total acumulado y el ranking
  relativo no reemplazan el promedio mensual. Los niveles desconocidos se excluyen.
- Cada recálculo global actualiza primero el LTV mediante su servicio y lock.
  El proceso diario existente ya llama este endpoint después de segmentar, por
  lo que no requiere cambiar el worker. Una falla de ranking queda registrada
  como `rankingStatus=unavailable` y no impide calcular la prioridad comercial.
- A igual puntaje, importe y cantidad de cargas de 90 días, luego 30 días,
  determinan el orden. Perfiles estimados, parciales o de más de 36 horas no se
  usan para desempatar. La fecha canónica es la de depósito; no incluye retiros.
- La pantalla separa “Nivel comercial” de “Ranking relativo” y expone cargas de
  90 días. “Ver detalle” muestra valor + urgencia, datos de 30/90 días, total,
  promedio mensual, meses activos, fechas, calidad y cuentas. El percentil muestra
  agente, plataforma y su propia fecha; datos de más de 36 horas aparecen vencidos.

## Simulación de solo lectura

Antes de recalcular, comparar la audiencia anterior y la nueva con las mismas
reglas de consentimiento, exclusiones, ventana y cooldown. Conservar los
resultados de producción fuera del repositorio y utilizar datos sintéticos en
las pruebas. El cambio de audiencia no elimina contactos, no cancela difusiones
existentes y no envía mensajes.

## Validación

Pruebas de funciones y orquestación para un contacto Bajo, independencia del LTV, nivel
manual/desconocido, antigüedad y falla del ranking. PostgreSQL local verifica
lectura canónica, fechas, desempates, aislamiento por plataforma, permisos y
transiciones de difusión. Prueba de interfaz para el desglose; revisión visual
con fixtures explícitos en 1440 y 390 píxeles. Publicación mediante el ejecutor
verificado del repositorio, con validación completa y CI del commit exacto.

No se necesitan migraciones de esquema ni cambios en los umbrales monetarios.
La comprobación posterior debe verificar `/release.json`, el recálculo completo,
LTV actualizado, igualdad de niveles comerciales, exclusión del caso auditado y la nueva UI.
