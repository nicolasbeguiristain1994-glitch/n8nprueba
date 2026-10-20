# Recomendaciones de volumen por línea

El módulo **Líneas** ofrece una orientación para planificar campañas a partir de
resultados reales. No predice una suspensión, no garantiza un volumen libre de
sanciones y no autoriza envíos. Consultar también
[Protección de campañas](campaign-risk-guard.md).

La recomendación por sí sola es informativa: no cambia `msg_per_day`,
`msg_per_hour`, `sending_enabled` ni los destinatarios. La opción por línea
**Respetar automáticamente la recomendación diaria** permite usarla como máximo
de campaña; ver [controles de protección](line-protection-controls.md). No genera mensajes para
completar muestras, no utiliza conversaciones artificiales y no propone cambiar
de línea para sortear restricciones.

## Unidades y evidencia

La política pura está en `frontend/lib/line-volume-policy.ts`, con versión
explícita. Usa días calendario de `America/Argentina/Buenos_Aires`; el límite de
Meta, en cambio, se mide en **24 horas móviles**. No mezclar ambas ventanas.

El cálculo reconstruye el escalón a partir de hasta 28 días, muestra evidencia
reciente y evalúa cada fecha una sola vez. Los días vacíos o de muestra pequeña
no justifican aumentos. Recargar la página no debe cambiar el resultado si la
evidencia no cambió. Las entradas deben representar una fila consolidada por
fecha, incluso ante duplicados, reintentos o recibos repetidos.

Usar campañas reales y resultados atribuibles a la línea. Excluir pruebas,
alertas operativas y otros mensajes ajenos a campañas. Distinguir intentos,
aceptaciones y entregas confirmadas: una respuesta `accepted`, un estado `sent`
o `held_for_quality_assessment` no equivalen a una entrega. Los estados `read`
también confirman entrega. No usar los contadores administrativos de cupo como
historial de entregas.

Los reintentos no crean destinatarios nuevos ni muestras independientes. El
historial antiguo puede sobrescribir un resultado al reintentar: estos datos no
son una auditoría inmutable de cada intento HTTP. Si no puede reconstruirse con
certeza el resultado o la línea, la evidencia se considera incompleta y no
habilita aumentos. Los registros de fallos preservados ayudan a evitar que un
reintento exitoso oculte el rechazo anterior.

Las bajas se cuentan por la línea de origen y el día en que se reciben,
deduplicando el teléfono dentro de ese día. Pueden responder a un mensaje
anterior; no se dividen por los envíos de ese día ni se presentan como una tasa
de la campaña. Una baja es una preferencia del destinatario, no una denuncia de
spam.

## Progresión preventiva

Escalones: **10, 25, 50, 75, 100, 150, 200, 300 y 500**. Una línea sin historial
suficiente parte de una orientación provisional de 25, acotada por su límite
configurado. Estos valores son decisiones del producto, no límites publicados
por Meta.

Para subir un escalón se necesitan al menos **tres días cerrados favorables en el
mismo escalón** y una muestra acumulada de al menos `max(50, 1,5 × escalón)`.
Además, cada día debe cumplir:

- Al menos 12 horas desde su último envío.
- Muestra diaria de al menos `ceil(80% × escalón)`: 8 en el escalón 10 y
  20 en el escalón 25. Sigue siendo obligatoria la muestra acumulada mínima
  de 50, incluso para recuperar el escalón 25 desde 10.
- Al menos 90% de entregas confirmadas y como máximo 5% de fallos.
- Cero bajas, rechazos `131049` y resultados desconocidos.
- Calidad Cloud GREEN y evidencia completa.

No se sube durante los siete días posteriores a una señal desfavorable. Una
solicitud de baja o un rechazo `131049` aconsejan reducir y revisar frecuencia,
audiencia y contenido. Con al menos diez intentos, más de 10% de fallos o menos
de 80% de entregas maduras también aconsejan reducir. Recibos recientes todavía
pendientes no deben provocar por sí solos una reducción por baja entrega.

Cinco bajas en el día, o al menos diez rechazos `131049` que representen 20% de
una muestra mínima de cincuenta intentos, detienen la recomendación del día.
Estos controles informativos no sustituyen los umbrales ni las pausas
persistentes de la protección de campañas.

Tras siete días sin actividad, se pierde la evidencia para sostener un volumen
alto. Reiniciar la observación no debe elevar un escalón ya reducido a 10.
Resolver una alerta retoma la observación desde 10, con siete días de espera
antes de contar días favorables. No se reutilizan los días anteriores ni el día
de resolución para aumentar: la nueva evidencia debe justificar la recuperación.

## Comprobaciones que prevalecen

Una alerta activa o pendiente de revisión, calidad YELLOW/RED, desconexión o
configuración que impida campañas prevalecen sobre la progresión. En Cloud, una
consulta de Meta ausente, futura o de más de seis minutos devuelve orientación
no disponible y cero envíos adicionales recomendados; no se presenta como
prueba de suspensión.

UNKNOWN/NA no equivalen a calidad alta: mantienen como máximo la orientación
provisional de 25 y no permiten aumentos. Evolution no dispone de esa
verificación oficial y conserva una orientación provisional sin ascensos
automáticos basados en supuesta calidad de Meta.

La cifra restante descuenta los resultados registrados de campaña del día,
incluidos fallos, y respeta el cupo diario configurado. No representa una
auditoría exacta de todos los intentos HTTP. La disponibilidad inmediata respeta
también el cupo horario. No es una reserva de capacidad ni una orden de envío. Mostrar el
próximo escalón como posibilidad condicionada a nueva evidencia, no como una
promesa para mañana.

## Límite compartido de Meta

El límite oficial corresponde al **portfolio comercial**, compartido por sus
líneas y WABAs. Cuenta destinatarios únicos contactados fuera de la ventana de
atención en 24 horas móviles. No sumar los límites de las líneas ni interpretar
las recomendaciones individuales como capacidad adicional del portfolio.

`messaging_limit_tier` está deprecado. Un valor histórico de ese campo no debe
mostrarse como límite oficial vigente. Meta documenta
`whatsapp_business_manager_messaging_limit`; mientras no exista una consulta
actual y una asociación comprobada al portfolio, indicar que el límite
compartido requiere verificación. La calidad GREEN tampoco significa ausencia
de restricciones: una WABA o negocio puede estar bloqueado aunque la línea sea
GREEN.

## Validación

Las pruebas deben usar datos sintéticos y simular Meta, sin enviar mensajes.
Cubrir cambio de día argentino, maduración de recibos, muestras pequeñas,
duplicados por fecha y mensaje, tres días favorables, rechazo de aumentos con
historial incompleto, recuperación desde 10, inactividad, revisión de riesgo,
bajas tardías, calidad desconocida, datos de Meta vencidos y cupos agotados.

Verificar que actualizar Líneas no cambia límites ni inicia campañas; un usuario
sólo puede ver recomendaciones de sus líneas accesibles. Los agregados de
historial deben estar acotados y obtenerse en conjunto, evitando una consulta
por línea o llamadas a Meta por cada fila de la tabla. Comprobar que la interfaz
muestra motivos, hora de verificación, muestra y estados sin identificar una
recomendación interna como garantía de Meta.

## Fuentes oficiales

Referencias consultadas el 19 de octubre de 2026:

- [Límites de mensajería y portfolio compartido](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits).
- [Cambios de límites vigentes desde octubre de 2025](https://developers.facebook.com/documentation/business-messaging/whatsapp/upcoming-messaging-limits-changes).
- [Calidad de mensajes](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages#message-quality).
- [Calidad de plantillas, incluido UNKNOWN](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-quality).
- [Pacing y mensajes retenidos](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-pacing).
- [Límites de marketing por destinatario y reintentos 131049](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates/per-user-limits).

Meta indica esperar al menos 24 horas antes de reintentar marketing a un
destinatario que recibió `131049`. Ese código no acredita por sí mismo un bloqueo
de la cuenta ni justifica reenviar desde otra línea.
