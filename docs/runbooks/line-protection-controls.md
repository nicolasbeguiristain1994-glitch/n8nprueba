# Protección de volumen y respuestas automáticas

## Recomendación como máximo de campaña

La opción **Respetar automáticamente la recomendación diaria** se configura por
línea desde **Líneas → Editar**. Las líneas existentes conservan la opción apagada
hasta que un operador autorizado la active. Encenderla no inicia campañas ni
reanuda incidentes de riesgo.

Con la opción activa, el emisor vuelve a calcular la recomendación usando los
mismos datos y política que muestra Líneas. Comparte el presupuesto entre todas
las campañas que usan esa línea. El día de recomendación corresponde a
`America/Argentina/Buenos_Aires`; los cupos configurados siguen sus ventanas
existentes de 24 horas y una hora. El valor recomendado es una orientación
interna, no el límite oficial de Meta ni una garantía contra restricciones.

Las campañas reservan capacidad antes de contactar al proveedor. Una reserva
atómica impide que dos campañas consuman el último lugar simultáneamente. Los
resultados inciertos conservan la reserva; sólo un resultado que demuestra que
no hubo envío permite liberarla. Reiniciar el proceso o repetir un trabajo no
autoriza un segundo envío.

Al agotar la capacidad, se conserva el destinatario pendiente y la campaña pasa
a **Esperando cupo recomendado**. La fecha que aparece es la próxima
comprobación, no una promesa de envío. Antes de continuar se vuelven a comprobar
el riesgo, la autorización del dueño, el estado de la línea y la recomendación.
El planificador usa únicamente los destinatarios ya registrados; no incorpora
nuevos contactos agregados después a la lista.

**Mantener en pausa** cambia esa espera a una pausa manual y cancela la
continuación automática. Nunca se reanudan automáticamente pausas por riesgo,
configuración, errores ni pausas manuales. Resolver una alerta tampoco equivale
a autorizar el reinicio.

Para que las campañas no consuman toda la capacidad de atención, la protección
reserva el 20% de los cupos diario y horario configurados (redondeado hacia
arriba, sin consumir toda la capacidad en cupos pequeños). Las respuestas solicitadas por clientes
no consumen el presupuesto recomendado de campañas, pero sí deben respetar los
cupos de la línea, la ventana de atención, las bajas y los bloqueos de riesgo.

## Límites de automatizaciones

Se aplican por teléfono y negocio/agente, compartidos entre reglas y líneas del
mismo negocio. Si el agente no puede identificarse, se usa el origen concreto,
sin atribuir consentimiento o actividad a otro negocio.

- Hasta tres respuestas automáticas en 24 horas móviles. Un nuevo mensaje del
  cliente no reinicia el conteo.
- El mismo cuerpo o enlace no se repite en esa ventana, aunque provenga de otra
  regla. Los intentos de resultado incierto también bloquean una repetición.
- Se separan los pasos para evitar una ráfaga de respuestas. Los pasos pendientes
  permanecen en la cola durable hasta que corresponda comprobarlos.
- La intervención del asesor cancela los pasos pendientes y detiene las
  automatizaciones durante 24 horas. La atención humana conserva prioridad. Un envío ya iniciado no puede retirarse;
  la pausa cancela los pasos que todavía no fueron autorizados para despacho.
- Un aviso automático de derivación sólo puede acompañar su propio evento de
  derivación. No puede usarse para ignorar una intervención humana posterior.
- Las respuestas permanecen en la línea que recibió la consulta. No se cambia de
  línea para sortear un bloqueo o falta de capacidad.

El límite automático no sustituye el consentimiento ni habilita mensajes fuera
de la ventana de atención. Los controles existentes de baja, conexión, riesgo,
reglas activas y creador autorizado se verifican nuevamente al enviar.

## Estado interno y validación

`159_line_protection_controls.sql` agrega reservas durables, presupuesto diario,
estado de conversación y la fecha de revisión de campañas en espera. Las tablas
internas nuevas tienen RLS y no son accesibles a roles públicos de la Data API.
La migración es compatible con la versión anterior durante el despliegue.

Las pruebas utilizan PostgreSQL local, proveedores simulados y contactos
sintéticos. Incluyen concurrencia, permisos revocados, señales de riesgo,
resultados inciertos, repetición de eventos, intervención humana y conservación
de la audiencia original. No deben enviar mensajes reales para probar cupos.
