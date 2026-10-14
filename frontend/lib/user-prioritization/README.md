# Prioridades de reactivación

El nivel comercial es el mismo que en Contactos: promedio de depósitos reales
por mes con depósitos, evaluado con `casino_monthly_value_tier`, o el nivel
manual explícito. El total histórico y el ranking LTV no reemplazan ese nivel.
Los niveles desconocidos no son elegibles.

## Puntaje y orden

`priority_score = value_score (0–60) + urgency_score (0–40)`.
El valor, las ventanas de inactividad y el cooldown se leen de
`segmentation_tiers`. La urgencia decae linealmente dentro de la ventana.
La inactividad parte del último depósito del perfil de Contactos. Los retiros
no reinician el contador. Sin perfil se conserva la fecha histórica del contacto.

A igual puntaje, se ordena por importe y cantidad de depósitos de los últimos
90 días y luego de 30 días. Se comparan solamente perfiles observados, completos
y calculados dentro de las últimas 36 horas; los demás quedan con desempate nulo.
El identificador del contacto estabiliza los empates restantes.

## Ranking relativo

`player_ltv` conserva el percentil de depósitos menos retiros de una cuenta
respecto de otras cuentas de su agente y plataforma. La pantalla lo presenta
como ranking informativo, con fecha y estado. No modifica el nivel, el puntaje,
la ventana de elegibilidad ni el cooldown.

Para contactos con varias cuentas se muestra el mayor percentil vigente; si
ninguno está vigente se muestra uno marcado como vencido. No se combinan cuentas
con el mismo nombre de usuario en plataformas diferentes. Las antiguas columnas
`ltv_score` y `ltv_tier` de prioridades se guardan en NULL en nuevos cálculos.

## Actualización

El endpoint existente `POST /api/contacts/recompute-priorities`, llamado por el
proceso diario después de segmentar, adquiere el lock de Prioridades y ejecuta
primero `LtvService.recomputeAll`. El ranking usa su propio lock distribuido.
Si falla o está ocupado, la clasificación comercial puede continuar y la
respuesta devuelve `rankingStatus=unavailable`. Los datos LTV vencidos nunca
alteran el puntaje; la interfaz muestra la última fecha y el estado por fila.

Los scores se actualizan en batches de 500 dentro de una transacción dedicada.
El último run completo y sus filas se publican juntos. Fallos revierten el
cálculo incompleto. El heartbeat renueva el lock por un canal independiente.

## Elegibilidad y visibilidad

Se excluyen contactos eliminados, de estado no operativo, bloqueados o sin
consentimiento, sin nivel conocido, sin fecha de depósito, fuera de la ventana
del nivel o contactados dentro del cooldown. El listado reevalúa exclusiones y
permisos del operador. La preparación de difusión vuelve a validar su audiencia.
Recalcular prioridades no envía comunicaciones ni cambia difusiones existentes.

## Explicación visible

“Ver detalle” muestra valor + urgencia, nivel comercial y asignación manual,
fecha del cálculo, importes y cantidad de cargas de 30/90 días, total observado,
promedio mensual, meses activos, calidad/fecha del historial y cuentas utilizadas.
El ranking tiene una fecha independiente. Las métricas del perfil se presentan
con su propia fecha, distinta de la del score si se actualizó el perfil después.

## Verificación

Las pruebas incluyen un caso sintético (Bajo, 14 días: no elegible aunque su LTV diga
Super VIP), niveles manuales, independencia del ranking, caducidad, secuencia de
actualización y fallo LTV. PostgreSQL local verifica la lectura canónica, el
orden por ventanas recientes, la exclusión de estimaciones del desempate y la
identidad de cuenta por plataforma, junto con permisos y estados de difusión.
