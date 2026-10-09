import type { EffectivePermissions, Resource } from '@/lib/permissions'

export interface GuideSection {
  id: string
  label: string
  subtitle: string
  description: string
  href?: string
  resource?: Resource
  adminOnly?: boolean
  steps: { title: string; detail: string }[]
  tips?: { kind: 'note' | 'tip' | 'example'; text: string }[]
}

// Review the corresponding screens and API behavior when changing this content.
// Keep configurable thresholds in Settings instead of copying defaults here.
export const GUIDE_REVIEWED_AT = '2 de octubre de 2026'

export const GUIDE_SECTIONS: GuideSection[] = [
  {
    id: 'agentes', label: 'Agentes y líneas designadas', subtitle: 'Cargar teléfonos y compartir la línea correspondiente', href: '/agentes', resource: 'agents', adminOnly: true,
    description: 'Los administradores gestionan los teléfonos asociados a cada agente, número de línea y variante. Conversaciones muestra la asignación del contacto junto al agente y su nivel.',
    steps: [
      { title: 'Cargá o editá una línea', detail: 'Abrí Agentes, elegí el agente y usá Agregar línea. Ingresá el número, la variante si corresponde, un nombre y el teléfono con + y código de país. Editar permite cambiar el nombre, el teléfono y el estado activo.' },
      { title: 'Respetá la asignación del contacto', detail: 'La combinación debe coincidir con el agente, línea y variante registrados en Contactos. Una línea 1A y una línea 1 sin variante son destinos diferentes. Si falta el número o hay asignaciones contradictorias, el chat lo indica sin elegir otro destino.' },
      { title: 'Compartí desde el chat', detail: 'Copiar guarda el teléfono en el portapapeles. Pegar en respuesta agrega la línea designada al borrador y conserva lo que ya escribiste. Revisá el texto y enviá cuando esté listo.' },
      { title: 'Actualizá los destinos de Ofizeus', detail: 'Las respuestas automáticas que consultan la línea designada de Ofizeus usan este mismo directorio. Los cambios aplican a nuevas respuestas; una línea inactiva deriva la consulta a un asesor.' },
    ],
  },
  {
    id: 'primeros-pasos', label: 'Primeros pasos', subtitle: 'Una rutina para empezar a trabajar',
    description: 'Usá el menú lateral para moverte entre módulos. Esta guía muestra los temas habilitados para tu cuenta; las acciones disponibles dependen además de tu rol y de los contactos, agentes y líneas asignados.',
    steps: [
      { title: 'Revisá el contexto de trabajo', detail: 'En Dashboard, comprobá el período, la plataforma y el agente seleccionados. Mirá la última actividad disponible antes de interpretar los importes. Los filtros se guardan en este navegador y pueden ser distintos en otra computadora.' },
      { title: 'Prepará la audiencia', detail: 'En Contactos, buscá y filtrá la base. Revisá los destinatarios y creá una lista. En Prioridades podés consultar el orden sugerido de atención; marcar un contacto como difundido sólo registra la gestión.' },
      { title: 'Prepará y revisá el envío', detail: 'Comprobá las líneas disponibles, el mensaje o la plantilla y los destinatarios. Guardá la campaña y, si usás una plantilla Cloud, enviá una prueba a un número propio registrado antes de iniciar la difusión.' },
      { title: 'Atendé y medí el resultado', detail: 'Revisá las respuestas en Conversaciones, registrá el trabajo en Mis Tareas y consultá Estadísticas. La efectividad se confirma con cargas posteriores al envío dentro de una ventana de 24 horas por destinatario.' },
    ],
    tips: [{ kind: 'note', text: 'Administrador: configura y gestiona el sistema. Operador: trabaja en sus sectores habilitados. Solo lectura: consulta información sin ejecutar las acciones de edición o envío. Si falta una opción, revisá los permisos con tu administrador.' }],
  },
  {
    id: 'dashboard', label: 'Dashboard', subtitle: 'Filtros, movimientos de casino y seguimiento de la operación', href: '/', resource: 'dashboard',
    description: 'El Dashboard reúne movimientos por plataforma, gráficos de depósitos y tarjetas de la operación. Elegí primero el alcance de la consulta para comparar datos equivalentes.',
    steps: [
      { title: 'Elegí fecha, plataforma y agente', detail: 'Usá los filtros superiores y verificá la línea “Filtro activo”. Podés consultar Zeus, Bet30, Ganamos, Argenbet o Consolidado. Consolidado reúne las plataformas disponibles; no es una plataforma adicional.' },
      { title: 'Interpretá depósitos, retiros y saldo', detail: 'Revisá los importes y la última actividad de cada plataforma. El saldo mostrado incluye los conceptos indicados en pantalla y no equivale a ganancia ni a monto apostado. Una cuenta sin configurar o sin datos debe interpretarse según su aviso, no como actividad confirmada en cero.' },
      { title: 'Explorá las cargas y la Caja', detail: 'Los gráficos permiten alternar Cantidad e Importe y consultar el detalle en tabla. En Caja revisá los movimientos del período y sus filtros antes de comparar totales. Las fechas se interpretan en hora argentina.' },
      { title: 'Actualizá o sincronizá según lo que necesites', detail: 'Actualizar vuelve a consultar los datos ya guardados. Sync casino solicita una sincronización; “iniciada” no significa que haya terminado. En Consolidado este botón solicita Zeus y Bet30; para otra plataforma, seleccionala y revisá el resultado de la solicitud.' },
      { title: 'Personalizá tu vista', detail: 'Con Personalizar podés elegir las tarjetas visibles y ordenar el tablero. Activá o desactivá la actualización automática desde el control superior.' },
    ],
    tips: [{ kind: 'tip', text: 'Si dos personas ven importes distintos, comparen período, plataforma, agente, permisos y última sincronización antes de volver a sincronizar.' }],
  },
  {
    id: 'contactos', label: 'Contactos y listas', subtitle: 'Importar, filtrar, consultar historial y preparar audiencias', href: '/contacts', resource: 'contacts',
    description: 'Contactos reúne teléfonos, nombres, agentes, líneas, etiquetas y datos vinculados del jugador. Las listas agrupan destinatarios para usarlos después en Campañas.',
    steps: [
      { title: 'Creá o encontrá un contacto', detail: 'Usá Nuevo contacto e ingresá un teléfono con código de país y área, por ejemplo 5491112345678. Completá el nombre y las asignaciones disponibles. La búsqueda principal permite encontrar contactos por nombre o teléfono.' },
      { title: 'Importá con una vista previa', detail: 'Importar acepta CSV, Excel (.xlsx y .xls) y VCF. En CSV/Excel usá encabezados como phone, tel o numero para el teléfono, y name o nombre para el nombre. Revisá la vista previa y las asignaciones de agente y línea antes de confirmar.' },
      { title: 'Decidí cómo tratar los existentes', detail: 'Si aparecen coincidencias, elegí entre Actualizar existentes, Solo agregar agente y línea u Omitir existentes. La segunda opción conserva el nombre y nivel; la tercera incorpora sólo los nuevos. Al finalizar, revisá el resultado de la importación.' },
      { title: 'Combiná filtros', detail: 'Podés filtrar por agente, línea, variante, juego, nivel, actividad, antigüedad, etiquetas y movimientos. Los filtros limitan la audiencia visible; no amplían los permisos de tu cuenta.' },
      { title: 'Armá una lista y revisá sus integrantes', detail: 'Usá Nueva lista y elegí el origen disponible: selección, filtros o criterios. Poné un nombre que describa la audiencia y revisá los miembros antes de usarla. Las listas también ofrecen descarga y división según tus permisos.' },
      { title: 'Consultá el detalle o descargá', detail: 'En las acciones del contacto, Más información muestra el historial disponible y la plataforma; Editar contacto permite corregir los datos habilitados. Descargar requiere permiso. Si no aparece o falla por acceso, pedí que revisen tu autorización.' },
    ],
    tips: [{ kind: 'example', text: 'Archivo mínimo de ejemplo: encabezados “phone,nombre” y una fila “5491112345678,Nombre de prueba”. Revisá cómo se interpretan las columnas en la vista previa antes de importar toda la base.' }],
  },
  {
    id: 'segmentacion', label: 'Segmentación y movimientos', subtitle: 'Elegir la audiencia sin confundir nivel, actividad y fechas', href: '/contacts', resource: 'contacts',
    description: 'Los filtros de nivel, actividad y antigüedad describen aspectos diferentes del contacto. Los datos dependen del historial vinculado, la sincronización y la configuración vigente.',
    steps: [
      { title: 'Distinguí las clasificaciones', detail: 'Nivel agrupa el valor del jugador: Bajo, Medio, VIP Bajo, VIP Medio, VIP Alto y Super VIP. Actividad describe su relación con las cargas recientes; Antigüedad, la duración del historial. Usá las descripciones de cada opción y evitá interpretar una categoría como un importe actual.' },
      { title: 'Filtrá por el último movimiento', detail: 'Días desde el último movimiento usa la última carga o retiro identificable. “Más de” excluye el límite inferior y “Hasta (inclusive)” incluye el superior. Quedan fuera quienes superan el máximo o no tienen movimientos identificables.' },
      { title: 'Buscá movimientos de un período anterior', detail: 'Movimientos ocurridos hace… incluye a quienes tuvieron al menos una carga o retiro dentro del rango, aunque también hayan tenido actividad más reciente. Al elegir este filtro se reemplaza el rango de último movimiento. Ambos usan días calendario de Argentina y respetan la plataforma elegida.' },
      { title: 'Usá Sin movimiento con su criterio propio', detail: 'Sin movimiento identifica ausencia de depósitos recientes durante 12 meses, o falta de depósitos registrados. Es un criterio distinto de los rangos de cargas y retiros. Combiná los filtros sólo si querés aplicar ambas condiciones.' },
      { title: 'Revisá reglas y actualización', detail: 'Los administradores pueden revisar Segmentación, Motor de Prioridades y LTV en Ajustes. Los umbrales y ventanas son configurables: consultá allí los valores vigentes. Actualizar una pantalla no importa movimientos nuevos ni recalcula por sí solo las clasificaciones.' },
    ],
    tips: [{ kind: 'example', text: 'Más de 7 y hasta 30 días desde el último movimiento selecciona contactos cuyo último movimiento fue hace 8 a 30 días. El rango de movimientos ocurridos hace 8 a 30 días puede incluir también a alguien que volvió a cargar ayer.' }],
  },
  {
    id: 'prospectos', label: 'Prospectos y listas de difusión', subtitle: 'Trabajar con la audiencia de difusión de Contactos', href: '/contacts', resource: 'contacts',
    description: 'En Contactos también están las vistas de Prospectos y Listas de Difusión. Sus listas se eligen como un tipo de audiencia propio al crear una campaña.',
    steps: [
      { title: 'Abrí la vista correspondiente', detail: 'Entrá a Contactos y elegí Prospectos o Listas de Difusión. Revisá los datos y filtros disponibles para tu cuenta antes de seleccionar destinatarios.' },
      { title: 'Creá y verificá la lista', detail: 'Creá una lista de difusión, seleccioná los prospectos y comprobá sus integrantes. No confundas esta lista con una lista de la base principal de contactos.' },
      { title: 'Elegí la audiencia correcta en Campañas', detail: 'En Nueva campaña, seleccioná Listas de Difusión en Tipo de audiencia y luego la lista. Para la base principal usá Contactos. Si la lista no aparece, verificá su tipo y tus permisos.' },
    ],
    tips: [{ kind: 'note', text: 'La efectividad necesita una cuenta de casino vinculada al destinatario. Un teléfono disponible para difusión puede no tener el historial necesario para verificar sus cargas.' }],
  },
  {
    id: 'prioridades', label: 'Prioridades', subtitle: 'Ordenar la atención y registrar qué contactos ya se gestionaron', href: '/prioridades', resource: 'contacts',
    description: 'Prioridades ordena los contactos elegibles mediante un puntaje de valor y urgencia. La lista respeta la visibilidad de tu cuenta y las reglas vigentes de actividad, consentimiento y frecuencia.',
    steps: [
      { title: 'Elegí la audiencia a revisar', detail: 'Usá los filtros de plataforma, agente, nivel y segmento de reactivación. Alterná entre Pendientes y Difundidos para consultar el estado de gestión.' },
      { title: 'Interpretá el puntaje', detail: 'El puntaje combina valor y urgencia. Cuando hay LTV disponible, se usa esa información; en otros casos se usa el monto o nivel registrado y la configuración vigente. El botón de ayuda explica el cálculo. El puntaje ordena la atención, no garantiza una carga futura.' },
      { title: 'Registrá la gestión', detail: 'Marcá como difundido después de realizar la gestión correspondiente. Esta acción no manda un WhatsApp ni crea una campaña. Si marcaste un contacto por error, usá la acción disponible para devolverlo a pendientes.' },
      { title: 'Comprobá la fecha del cálculo', detail: 'La fecha del último cálculo indica cuándo se generó la lista. Actualizar vuelve a consultar esa lista; Recalcular, disponible para administradores, la vuelve a generar con los datos sincronizados y las reglas actuales.' },
    ],
    tips: [{ kind: 'note', text: 'Un contacto puede quedar fuera por falta de consentimiento, bloqueo, ventana de actividad, contacto reciente o permisos. Revisá esos motivos antes de atribuir su ausencia a un error.' }],
  },
  {
    id: 'campanas', label: 'Campañas', subtitle: 'Preparar, probar, enviar y seguir una difusión', href: '/campaigns', resource: 'campaigns',
    description: 'Cada campaña reúne una audiencia, un mensaje o plantilla y una configuración de envío. Los envíos dependen de los permisos, la disponibilidad de las líneas, los horarios y los límites vigentes.',
    steps: [
      { title: 'Creá la campaña y elegí la audiencia', detail: 'Entrá en Nueva campaña, poné un nombre descriptivo y seleccioná el tipo. En Tipo de audiencia elegí Contactos o Listas de Difusión, y después la lista correspondiente. Revisá los destinatarios antes de iniciar.' },
      { title: 'Prepará texto o plantilla Cloud', detail: 'Para texto libre, escribí el mensaje y agregá las variantes o archivos admitidos por el formulario. Para WhatsApp Cloud, elegí una plantilla aprobada asociada a la cuenta de WhatsApp Business (WABA). Completá sus variables, encabezado y botones requeridos; revisá la vista previa y los avisos.' },
      { title: 'Personalizá y probá', detail: 'En texto podés usar {{nombre}}. En las variables de una plantilla, la opción de usar el nombre inserta el dato de cada contacto. Para una campaña Cloud guardada, abrí Enviar prueba, registrá un número propio, elegí una línea y verificá el mensaje recibido. La prueba conserva su historial y respeta los límites de la línea y de Meta.' },
      { title: 'Guardá o programá el envío', detail: 'Configurá las pausas mínima y máxima dentro de los valores que admite el formulario. Guardar campaña crea el borrador. Si la programación automática está habilitada, elegí fecha y hora argentina y usá Programar campaña; si está deshabilitada, la pantalla lo indica y el inicio debe ser manual.' },
      { title: 'Cambiá la fecha o la hora', detail: 'En una campaña Programada, usá Editar horario. Elegí una fecha y hora futuras de Argentina, revisá el nuevo horario y pulsá Guardar horario. El formato es de 24 horas: 17:30 equivale a las 5:30 de la tarde. La opción está disponible antes de que empiece el envío y requiere permisos de edición y envío. Si otra persona cambió la programación o el envío ya comenzó, actualizá la lista antes de seguir.' },
      { title: 'Iniciá y observá los resultados', detail: 'Usá la acción de envío disponible para el borrador y comprobá las líneas elegibles. En el detalle, Enviado significa que el proveedor aceptó el envío; Entregado y Leído requieren su confirmación posterior. Omitido es un destinatario que no se envió por las reglas aplicadas. Completada significa que se procesó la campaña, no que todos hayan recibido o leído el mensaje.' },
      { title: 'Resolvé pausas y fallos', detail: 'Leé el motivo de la pausa: conexión, cupo, horario, frecuencia o configuración. Corregí la causa y usá Reanudar cuando corresponda. Reintentar toma fallos confirmados y omitidos por frecuencia; conserva el historial, excluye envíos entregados o pendientes de confirmación y vuelve a evaluar los límites vigentes.' },
    ],
    tips: [
      { kind: 'note', text: 'Sincronizar estados actualiza las confirmaciones de entrega y lectura de Evolution; no es un nuevo envío. Reiniciar destinatarios, disponible para administradores, se limita a quienes no tienen un envío confirmado: no borra todo el historial ni debe usarse como una prueba masiva.' },
      { kind: 'tip', text: 'Las variantes y las pausas ayudan a organizar el envío, pero no garantizan entrega ni evitan bloqueos. Usá audiencias autorizadas, mensajes pertinentes y los límites configurados.' },
    ],
  },
  {
    id: 'estadisticas', label: 'Estadísticas', subtitle: 'Interpretar envíos, respuestas y reportes', href: '/estadisticas', resource: 'estadisticas',
    description: 'Estadísticas ofrece Resumen, Campañas, Líneas, Plantillas e IA Analytics. Elegí el período y la vista según lo que querés medir; las métricas usan hora argentina.',
    steps: [
      { title: 'Elegí el período', detail: 'Usá Hoy, Ayer, Últimos 7 días, Últimos 30 días, Este mes o las fechas Desde y Hasta. Actualizar vuelve a consultar los resultados con ese filtro.' },
      { title: 'Distinguí Resumen y Campañas', detail: 'Resumen muestra actividad del período. En Campañas, el período selecciona campañas por su fecha de creación y los resultados muestran el estado actual de sus destinatarios. Abrí una campaña para ver su detalle completo y evolución; estos totales pueden diferir de la actividad del mismo período en Resumen.' },
      { title: 'Leé los estados y porcentajes', detail: 'Enviados incluye los envíos que luego se entregaron o leyeron; Entregados incluye los leídos. No sumes esas tarjetas como grupos separados. Las tasas de entrega y lectura se calculan sobre los enviados.' },
      { title: 'Interpretá las respuestas', detail: 'Respuestas cuenta mensajes recibidos, no personas únicas. Un contacto puede responder varias veces. La atribución usa el mensaje de campaña citado o el último envío de campaña de esa conversación.' },
      { title: 'Compará y exportá', detail: 'Líneas y Plantillas ayudan a comparar su actividad. Usá CSV o Exportar CSV donde esté disponible; los archivos respetan el alcance autorizado. IA Analytics complementa los datos disponibles: revisá sus conclusiones contra las métricas antes de decidir.' },
    ],
    tips: [{ kind: 'note', text: 'Las confirmaciones pueden llegar después del envío. Una lectura o respuesta no convierte por sí sola a un destinatario en efectivo: esa medición usa las cargas de casino.' }],
  },
  {
    id: 'efectividad', label: 'Efectividad de campañas · 24 horas', subtitle: 'Usuarios efectivos, cuentas, plataformas y monto cargado', href: '/estadisticas', resource: 'estadisticas',
    description: 'En Estadísticas → Campañas, abrí una campaña y buscá Efectividad de la campaña · 24 horas. Ahí se relacionan sus envíos con las cargas sincronizadas de las cuentas vinculadas.',
    steps: [
      { title: 'Entendé cuándo cuenta como efectivo', detail: 'Un destinatario es efectivo si registra una carga positiva después de su envío y hasta 24 horas después, inclusive. La ventana empieza en el envío de ese destinatario, no en la creación de la campaña. Las cargas anteriores o en el instante del envío y los bonos identificados quedan fuera.' },
      { title: 'Leé cantidad y tasa', detail: 'Cada destinatario cuenta una sola vez aunque haya hecho varias cargas. La tasa es usuarios efectivos divididos por enviados, multiplicado por 100. Mientras existan ventanas abiertas, el resultado es provisional.' },
      { title: 'Consultá quién cargó y dónde', detail: 'Destinatarios efectivos muestra Contacto, Usuario, Plataforma, Resultado, Enviado, Primera carga, Cargas y Monto cargado · 24 h. Si una persona cargó desde varias cuentas, aparecen los usuarios y plataformas correspondientes, en el mismo orden. Usá Anterior y Siguiente para recorrer la lista.' },
      { title: 'Interpretá el monto', detail: 'Monto cargado · 24 h suma los depósitos que cumplen la ventana. Las cuentas compartidas pueden figurar en más de un destinatario; el total de la campaña evita sumar dos veces el mismo movimiento. Por eso no siempre coincide con sumar manualmente todas las filas.' },
      { title: 'Revisá los avisos de datos incompletos', detail: 'Sin cuenta vinculada o sin hora de envío no se pueden verificar las cargas. Los movimientos sin hora exacta se informan, pero quedan fuera de los efectivos. Una sincronización posterior puede incorporar datos que faltaban.' },
    ],
    tips: [
      { kind: 'example', text: 'Si el envío fue el lunes a las 18:00, una carga a las 20:00 o el martes a las 18:00 entra en la ventana; una a las 18:01 del martes queda fuera. Con 20 efectivos de 80 enviados, la efectividad es 25%.' },
      { kind: 'note', text: 'Cada campaña se evalúa por separado: una carga puede coincidir con las ventanas de dos campañas. Esto indica actividad posterior al envío, no prueba que el mensaje haya causado la carga.' },
      { kind: 'note', text: 'Monto apostado figura como “No disponible”: la integración actual registra cargas y retiros, no apuestas. El monto cargado no debe interpretarse como monto apostado.' },
    ],
  },
  {
    id: 'conversaciones', label: 'Conversaciones', subtitle: 'Responder, consultar contexto y registrar seguimientos', href: '/conversations', resource: 'conversations',
    description: 'La bandeja reúne los hilos que tu cuenta puede consultar. Abrí un contacto para leer su historial, el contexto de campañas y las acciones disponibles.',
    steps: [
      { title: 'Encontrá la conversación', detail: 'Buscá por nombre o teléfono y usá los filtros de campaña, nivel y fechas disponibles. Cargar más trae los hilos restantes. En pantallas pequeñas podés alternar entre la lista, el chat y el detalle del contacto.' },
      { title: 'Revisá el contexto antes de responder', detail: 'Leé los mensajes anteriores y la campaña vinculada. Comprobá los datos del contacto y los avisos de atención. Las notas internas permiten dejar contexto para el equipo sin enviarlo por WhatsApp.' },
      { title: 'Enviá la respuesta', detail: 'Escribí en el campo de respuesta: Enter envía y Shift+Enter agrega una línea. Podés usar los accesos de texto disponibles y revisar el contenido antes de enviarlo. Si falla, leé el error y verificá la conexión y el acceso a la línea.' },
      { title: 'Registrá el seguimiento', detail: 'Usá Marcar En Proceso mientras gestionás el caso y Resolver (quitar En Proceso) al terminar. Programar seguimiento guarda el recordatorio o nota de gestión disponible en la conversación; no envía un mensaje programado al cliente.' },
    ],
    tips: [{ kind: 'note', text: 'Para números oficiales también existe la Bandeja de WhatsApp API, accesible desde Líneas. Permite texto libre dentro de las 24 horas del último mensaje del cliente y plantilla aprobada fuera de esa ventana. Esa ventana de atención es distinta de las 24 horas usadas para medir efectividad.' }],
  },
  {
    id: 'plantillas', label: 'Plantillas', subtitle: 'Crear mensajes y gestionar su revisión en Meta', href: '/templates', resource: 'templates',
    description: 'Plantillas permite crear, editar, duplicar y consultar mensajes reutilizables. Las plantillas Cloud se identifican por cuenta de WhatsApp Business, nombre e idioma y deben estar aprobadas para usarse en campañas.',
    steps: [
      { title: 'Creá el contenido', detail: 'Definí nombre, idioma y categoría. Completá el cuerpo y, si corresponde, encabezado, pie y botones. La vista previa ayuda a revisar cómo queda el mensaje.' },
      { title: 'Completá variables y ejemplos', detail: 'En las plantillas se usan variables numeradas, como {{1}} y {{2}}. Agregá los ejemplos solicitados para revisión. Al crear la campaña asignás los valores reales, incluido el nombre del contacto cuando corresponda.' },
      { title: 'Revisá la cuenta y el estado', detail: 'Para Cloud, comprobá la cuenta WABA y el idioma. Usá Enviar a revisión de Meta cuando la acción esté disponible y Actualizar estado desde Meta para consultar el resultado. Si fue rechazada, leé el motivo antes de corregirla.' },
      { title: 'Usá el catálogo aprobado', detail: 'En Campañas, Sincronizar desde Meta actualiza el catálogo disponible. Si una plantilla no aparece, comprobá que esté aprobada, que pertenezca a la cuenta de las líneas y que haya sido sincronizada.' },
    ],
    tips: [{ kind: 'note', text: 'Guardar una plantilla local no equivale a tener aprobación de Meta. La bandeja Cloud admite desde su formulario plantillas aprobadas sin variables; las que requieren parámetros se preparan en Campañas.' }],
  },
  {
    id: 'lineas', label: 'Líneas', subtitle: 'Conectar WhatsApp y comprobar si puede enviar', href: '/lines', resource: 'lines',
    description: 'Líneas muestra los números de WhatsApp disponibles, su conexión y su elegibilidad para campañas. Se admiten conexiones Evolution por QR y WhatsApp Cloud mediante Meta.',
    steps: [
      { title: 'Revisá conexión y elegibilidad', detail: 'Una línea conectada puede no estar habilitada para campañas. Revisá el control de envíos, cupo, horario y el motivo de no elegibilidad que muestra la pantalla. El detalle incluye la información de conexión disponible.' },
      { title: 'Conectá o reconectá mediante QR', detail: 'Elegí WhatsApp vía código QR, completá la instancia y usá Vincular QR u Obtener QR. Escanealo desde los dispositivos vinculados de WhatsApp. Si vence, generá uno nuevo; una vez escaneado, esperá la confirmación de conexión antes de cerrar la ventana.' },
      { title: 'Conectá un número oficial', detail: 'Elegí WhatsApp Cloud y seguí el asistente de Meta Business disponible. También existe Conectar con WABA ID y token de usuario de sistema para la configuración administrativa. Revisá que el número haya quedado registrado y apto para el envío.' },
      { title: 'Atendé los mensajes Cloud', detail: 'Abrí la Bandeja de WhatsApp API desde la línea y seleccioná el número. Actualizar mensajes y estados vuelve a consultar el historial. La conexión con Chatwoot es opcional; la bandeja propia permite consultar y responder sin crear un inbox externo.' },
      { title: 'Elegí bien la acción de mantenimiento', detail: 'Desactivar envíos impide usar la línea para campañas. Desvincular cierra la sesión y conserva el registro; podés volver a vincularla. Eliminar quita la línea según las restricciones de la pantalla. Usá cada acción sólo para el cambio que necesitás.' },
    ],
  },
  {
    id: 'mis-tareas', label: 'Mis Tareas', subtitle: 'Ejecutar el trabajo asignado y registrar el resultado', href: '/mis-tareas', resource: 'tasks',
    description: 'Mis Tareas reúne el trabajo asignado a tu cuenta, sus instrucciones, fechas y recursos relacionados.',
    steps: [
      { title: 'Revisá tus pendientes', detail: 'Buscá por título o instrucciones y filtrá por estado. Revisá prioridad, fecha programada y vencimiento antes de empezar.' },
      { title: 'Abrí el detalle e iniciá la tarea', detail: 'Leé la descripción y las notas del administrador. Usá la acción para iniciar y los accesos al recurso relacionado cuando estén disponibles, por ejemplo una campaña o lista.' },
      { title: 'Completá con una nota de resultado', detail: 'Después de realizar el trabajo, marcá la tarea como completada y agregá el resultado cuando corresponda. Actualizar vuelve a consultar la lista y los contadores.' },
    ],
    tips: [{ kind: 'note', text: 'Completar una tarea registra el trabajo; no inicia por sí solo una campaña ni confirma que sus mensajes se hayan entregado. Revisá el resultado en el módulo correspondiente.' }],
  },
  {
    id: 'calendario', label: 'Calendario', subtitle: 'Organizar tareas y contenido de marketing por fecha y hora', href: '/calendario', resource: 'tasks',
    description: 'El Calendario combina la planificación de tareas con contenido de marketing. Podés consultar la vista Mensual o Por día / hora.',
    steps: [
      { title: 'Elegí la vista y el período', detail: 'Navegá por mes o seleccioná un día. Usá los filtros de tipo y prioridad; los administradores también pueden filtrar por operador. Abrí un elemento para ver su detalle.' },
      { title: 'Revisá las tareas y sus fechas', detail: 'Diferenciá la fecha de inicio programada de la fecha límite. Las tareas que no tienen fecha aparecen en Sin fecha programada.' },
      { title: 'Planificá contenido de marketing', detail: 'En la vista diaria, usá Agregar contenido de marketing si tu rol lo permite. Completá título, texto, fecha y material disponible. Revisá el horario y guardá los cambios.' },
    ],
    tips: [{ kind: 'note', text: 'Anotar contenido de marketing en el calendario organiza el trabajo. Para enviar una difusión tenés que crear e iniciar o programar su campaña en Campañas.' }],
  },
  {
    id: 'automatizaciones', label: 'Automatizaciones', subtitle: 'Respuestas automáticas, derivaciones e historial de ejecución', href: '/automatizaciones', resource: 'automations',
    description: 'Las automatizaciones aplican acciones a mensajes entrantes según una condición. Los administradores crean y gestionan las reglas; las cuentas con acceso de lectura pueden consultar las reglas y sus ejecuciones dentro del panel.',
    steps: [
      { title: 'Creá la regla', detail: 'Usá Crear automatización, indicá el nombre y elegí Respuesta automática, Flujo o Derivación a humano. Completá una descripción que ayude al equipo a reconocer su propósito.' },
      { title: 'Elegí el disparador', detail: 'Palabra exacta, Contiene y Cualquier mensaje determinan cuándo puede aplicarse la regla. Completá las palabras y la prioridad disponibles en el formulario. Se elige la primera regla coincidente, empezando por el menor número de prioridad; revisá las reglas existentes antes de agregar otra.' },
      { title: 'Configurá la acción', detail: 'En Respuesta automática, escribí el mensaje. En Derivación a humano, podés agregar un mensaje previo y la conversación se marca para atención. En Flujo, escribí un mensaje por línea: los pasos se procesan en orden y cada resultado queda en el historial. Si hay un envío sin confirmación, revisá el historial antes de intentar repetirlo.' },
      { title: 'Evitá respuestas repetidas', detail: 'En Respuesta automática, activá Enviar esta respuesta solo una vez por chat. Cada teléfono recibe esa automatización una sola vez, aunque repita la palabra, toque otro botón de la misma regla o escriba a otra línea. Se reconoce el historial anterior; el límite no vence a las 24 horas ni se reinicia al editar el texto. Un envío sin confirmación bloquea nuevos intentos para evitar duplicados. Los errores confirmados sin envío o los casos omitidos pueden volver a evaluarse ante un nuevo mensaje. Las repeticiones quedan como Ignorada en el historial.' },
      { title: 'Activá y comprobá el historial', detail: 'Guardá la regla con su estado inicial. Podés Pausar, Activar o Editar según tus permisos. En Historial de ejecuciones revisá si una ejecución fue Ejecutada, Ignorada o Error y leé el detalle antes de modificar la regla.' },
    ],
    tips: [{ kind: 'note', text: 'Una regla pausada, un número bloqueado o una conversación derivada a atención humana pueden impedir una respuesta automática. La respuesta usa la línea por la que entró el mensaje y depende de que siga disponible.' }],
  },
  {
    id: 'blacklist', label: 'Blacklist', subtitle: 'Gestionar los números excluidos de los envíos', href: '/blacklist', resource: 'blacklist', adminOnly: true,
    description: 'Blacklist Global centraliza los números bloqueados. Su gestión está reservada a administradores.',
    steps: [
      { title: 'Buscá y revisá el bloqueo', detail: 'Buscá por número y filtrá por origen o estado. Revisá el motivo antes de cambiar una entrada.' },
      { title: 'Agregá o importá números', detail: 'Podés ingresar uno o varios números, uno por línea, y elegir un motivo. Importar permite cargar un archivo y revisar los números antes de confirmar.' },
      { title: 'Quitá un bloqueo sólo cuando corresponda', detail: 'Usá Quitar de blacklist y revisá la confirmación. El desbloqueo no reemplaza la revisión del consentimiento y las demás reglas necesarias para enviar mensajes.' },
    ],
  },
  {
    id: 'tareas', label: 'Tareas del equipo', subtitle: 'Crear, asignar y supervisar el trabajo', href: '/tareas', resource: 'tasks', adminOnly: true,
    description: 'Tareas permite a los administradores organizar el trabajo del equipo y consultar su avance.',
    steps: [
      { title: 'Creá una tarea clara', detail: 'Definí título, tipo, instrucciones, operador, prioridad y las fechas que correspondan. Vinculá la campaña o lista si el tipo de tarea lo permite.' },
      { title: 'Controlá el avance', detail: 'Filtrá por estado, tipo, prioridad u operador. Abrí el detalle para leer instrucciones, notas e historial. Las acciones masivas permiten aplicar los cambios disponibles a la selección.' },
      { title: 'Mantené las asignaciones', detail: 'Editá la tarea o reasignala desde las acciones disponibles. Para eliminarla, registrá el motivo solicitado; cuando corresponda, la opción Restaurar permite recuperarla.' },
    ],
  },
  {
    id: 'usuarios', label: 'Usuarios y visibilidad', subtitle: 'Configurar roles, sectores y acceso a contactos', href: '/users', resource: 'users', adminOnly: true,
    description: 'Usuarios define quién entra al panel y qué puede consultar o gestionar. El acceso a un módulo y la visibilidad de sus datos se configuran por separado.',
    steps: [
      { title: 'Creá o editá la cuenta', detail: 'Completá email, nombre, contraseña y rol: Administrador, Operador o Solo lectura. Asigná sólo los sectores que necesita esa persona.' },
      { title: 'Definí las restricciones adicionales', detail: 'Revisá Agentes permitidos y Permitir descarga de contactos. La descarga puede depender también de la configuración global. Dar acceso a Contactos no equivale a habilitar toda la base o su exportación.' },
      { title: 'Asigná la visibilidad', detail: 'En operadores y usuarios de lectura, abrí Gestionar visibilidad. Buscá y filtrá los contactos disponibles, asigná los que correspondan y revisá el conjunto asignado. Estas asignaciones afectan las consultas y acciones sobre contactos.' },
      { title: 'Mantené las cuentas', detail: 'Usá Cambiar contraseña, Desactivar o Activar cuando corresponda. Si una persona no ve un contacto, revisá su rol, sector, agentes y asignaciones antes de modificar los datos del contacto.' },
    ],
  },
  {
    id: 'ajustes', label: 'Ajustes', subtitle: 'Configuración vigente, reglas y auditoría', href: '/settings', resource: 'settings',
    description: 'Ajustes reúne la configuración del entorno y las reglas operativas. Las opciones de modificación y los cálculos administrativos dependen de tu rol.',
    steps: [
      { title: 'Revisá la sección correspondiente', detail: 'General, Contactos, Casino, Límites y Permisos agrupan las preferencias y restricciones disponibles. Guardá cada sección y esperá su confirmación antes de pasar a otra.' },
      { title: 'Consultá las reglas de segmentación y prioridad', detail: 'Segmentación define niveles, ventanas y valores configurables. Motor de Prioridades y Frecuencia controlan criterios de orden y recontacto. Revisá los valores actuales y el efecto del cambio; algunos campos requieren una confirmación adicional.' },
      { title: 'Interpretá LTV', detail: 'LTV muestra un puntaje relativo calculado por plataforma y agente con los datos disponibles. No es un importe apostado ni una promesa de ingresos. Los administradores pueden usar Recalcular LTV y comprobar la fecha del último cálculo exitoso.' },
      { title: 'Consultá Auditoría', detail: 'Los administradores pueden revisar el historial de cambios en Auditoría. Para investigar una diferencia, identificá la configuración anterior, la nueva y cuándo se modificó.' },
    ],
    tips: [{ kind: 'tip', text: 'No tomes los números de una guía antigua como límites actuales: las reglas vigentes se consultan en estas pantallas. Si sólo tenés acceso de lectura, pedí el cambio a un administrador.' }],
  },
  {
    id: 'problemas-frecuentes', label: 'Problemas frecuentes', subtitle: 'Qué revisar cuando algo no coincide o no aparece',
    description: 'Antes de repetir una acción, conservá el mensaje de error y comprobá el contexto. Estos pasos ayudan a identificar la causa sin duplicar envíos o importaciones.',
    steps: [
      { title: 'No veo un módulo, una lista o un contacto', detail: 'Revisá la búsqueda y los filtros activos. Para módulos, comprobá sectores y rol; para datos, agentes y visibilidad asignada. En Campañas verificá además el tipo de audiencia. El administrador puede revisar estas autorizaciones en Usuarios.' },
      { title: 'La campaña quedó pausada o no avanza', detail: 'Abrí su detalle y leé el motivo. Comprobá conexión, envío habilitado, cupo y horario de las líneas, plantilla Cloud y reglas de frecuencia. Si hay un envío pendiente de confirmación, revisá su estado antes de intentar otro envío.' },
      { title: 'Una carga no aparece como efectiva', detail: 'Comprobá que el usuario y la plataforma estén vinculados al destinatario, que exista hora exacta del envío y de la carga y que la carga esté dentro de sus 24 horas. Revisá que los datos ya se hayan sincronizado y que no sea un bono identificado.' },
      { title: 'Los totales no coinciden entre pantallas', detail: 'Compará fechas, plataforma, agente y alcance de permisos. Resumen mide actividad del período; Campañas muestra resultados actuales por destinatario. Las respuestas son mensajes y la efectividad cuenta destinatarios una vez. Tampoco sumes montos entre campañas como si cada carga fuera exclusiva de una sola.' },
      { title: 'No aparece una plantilla o falla una respuesta Cloud', detail: 'Revisá cuenta WABA, idioma, aprobación, sincronización y disponibilidad de la línea. Para texto libre Cloud, verificá la ventana de atención desde el último mensaje del cliente. Las plantillas con variables se preparan en Campañas.' },
      { title: 'Necesito ayuda para resolver un error', detail: 'Compartí con tu administrador el módulo, nombre de la campaña o tarea, hora del intento, filtros usados y texto del error. Incluí una captura si ayuda a identificarlo; no compartas contraseñas ni tokens de conexión.' },
    ],
  },
]

export function guideSectionsForUser(role: string | undefined, permissions: EffectivePermissions) {
  return GUIDE_SECTIONS.filter(section => {
    if (section.adminOnly && role !== 'admin') return false
    return !section.resource || role === 'admin' || permissions[section.resource]?.includes('read')
  })
}

export function normalizeGuideSearch(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es-AR').trim()
}

export function matchesGuideSearch(section: GuideSection, search: string) {
  const text = normalizeGuideSearch([
    section.label, section.subtitle, section.description,
    ...section.steps.flatMap(step => [step.title, step.detail]),
    ...(section.tips ?? []).map(tip => tip.text),
  ].join(' '))
  return normalizeGuideSearch(search).split(/\s+/).every(word => text.includes(word))
}
