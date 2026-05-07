'use client'

import { useState, useEffect, useRef } from 'react'
import { useCurrentUser } from '@/lib/useCurrentUser'
import {
  LayoutDashboard, Users, Megaphone, MessageSquare, Activity, Flame,
  ClipboardList, CheckSquare, CalendarDays, BarChart2, Bot, ShieldOff,
  FileText, UserCog, Settings, ChevronRight, ChevronDown,
  Lightbulb, AlertTriangle, Info, Star, ArrowRight,
  HelpCircle, BookOpen, Tag,
  QrCode, TrendingUp, Pause, Trash2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/PageHeader'
import { cn } from '@/lib/utils'

// ── Types ─────────────────────────────────────────────────────────────────────

type Role = 'admin' | 'operator' | 'both'

interface ActionItem {
  icon: React.ElementType
  label: string
  desc: string
  color?: string
}

interface Step {
  title: string
  detail: string
  actions?: ActionItem[]
}

interface Tip {
  type: 'tip' | 'warning' | 'info' | 'example'
  text: string
}

interface ModuleSection {
  id: string
  label: string
  icon: React.ElementType
  role: Role
  color: string
  subtitle: string
  description: string
  steps: Step[]
  tips: Tip[]
  adminOnly?: boolean
}

// ── Module documentation ──────────────────────────────────────────────────────

const MODULES: ModuleSection[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: LayoutDashboard,
    role: 'both',
    color: 'text-slate-600',
    subtitle: 'Vista general del estado del sistema',
    description:
      'El Dashboard es la pantalla de inicio. Muestra en tiempo real los indicadores más importantes: líneas activas, mensajes enviados hoy, campañas en curso y conversaciones pendientes. Es el punto de partida para entender qué está pasando en la plataforma.',
    steps: [
      {
        title: 'Revisar los KPIs del día',
        detail:
          'Al entrar verás las tarjetas de métricas clave: líneas activas, mensajes enviados hoy, campañas activas y conversaciones abiertas. Si un número aparece en rojo, hay algo que necesita atención inmediata.',
      },
      {
        title: 'Interpretar las alertas',
        detail:
          'Si una línea está desconectada o una campaña falló, el dashboard mostrará una alerta. Hacé clic en el ícono o en el enlace de la alerta para ir directamente al módulo que tiene el problema.',
      },
      {
        title: 'Refrescar los datos',
        detail:
          'Los datos se actualizan automáticamente cada 30 segundos. También podés hacer clic en el botón "Refrescar" para forzar la actualización manual.',
      },
    ],
    tips: [
      {
        type: 'tip',
        text: 'Usá el Dashboard como punto de partida cada vez que entrás al sistema. En 30 segundos ya sabés si todo está funcionando correctamente.',
      },
      {
        type: 'info',
        text: 'Los operadores ven solo los módulos a los que su administrador les dio acceso. Si no ves alguna sección, pedile acceso al administrador.',
      },
    ],
  },

  {
    id: 'contactos',
    label: 'Contactos',
    icon: Users,
    role: 'both',
    color: 'text-blue-600',
    subtitle: 'Gestión del directorio de contactos',
    description:
      'El módulo de Contactos almacena todos los números de WhatsApp y sus datos asociados. Podés importar contactos en masa desde Excel/CSV, crear contactos individuales, organizarlos en listas y filtrarlos por múltiples criterios.',
    steps: [
      {
        title: 'Importar contactos desde un archivo',
        detail:
          'Hacé clic en "Importar CSV". Descargá la plantilla de ejemplo, completala con tus contactos (columnas: nombre, teléfono, email, tags) y subí el archivo. La plataforma te mostrará una vista previa antes de importar y te avisará si hay números duplicados o inválidos.',
      },
      {
        title: 'Crear un contacto individual',
        detail:
          'Hacé clic en "Nuevo contacto". Ingresá el número en formato internacional (ej: 5491112345678, sin + ni espacios). Podés agregar nombre, email, notas y etiquetas. El número es el único campo obligatorio.',
      },
      {
        title: 'Buscar y filtrar',
        detail:
          'Usá la barra de búsqueda para encontrar contactos por nombre, teléfono o email. El filtro avanzado te permite combinar criterios: por lista, por etiqueta, por fecha de creación o por estado (activo/bloqueado).',
      },
      {
        title: 'Organizar en listas',
        detail:
          'Seleccioná varios contactos con los checkboxes y hacé clic en "Agregar a lista". Las listas sirven para segmentar audiencias antes de crear una campaña. Un contacto puede pertenecer a múltiples listas.',
      },
      {
        title: 'Editar o eliminar un contacto',
        detail:
          'Hacé clic en los tres puntos (...) al lado de cualquier contacto para ver las opciones: editar, agregar a lista, enviar mensaje directo o eliminar.',
      },
    ],
    tips: [
      {
        type: 'example',
        text: 'Ejemplo: Tenés 2.000 clientes de tu base de datos de Excel. Los exportás a CSV con columnas nombre, teléfono, ciudad. Los importás a la plataforma, creás una lista "Clientes Buenos Aires" filtrando por ciudad, y luego usás esa lista para una campaña segmentada.',
      },
      {
        type: 'warning',
        text: 'Los números deben estar en formato internacional SIN el signo +. Para Argentina: 549 + código de área + número (ej: 5491155667788).',
      },
      {
        type: 'tip',
        text: 'Usá etiquetas (tags) para clasificar contactos por interés, estado de compra o cualquier criterio de tu negocio. Las etiquetas facilitan los filtros después.',
      },
    ],
  },

  {
    id: 'segmentacion',
    label: 'Segmentación de Jugadores',
    icon: Tag,
    role: 'admin',
    color: 'text-pink-600',
    subtitle: 'Cómo se clasifican automáticamente los jugadores del casino',
    description:
      'Cada jugador importado desde el panel del casino recibe automáticamente tres clasificaciones: Nivel de monto (cuánto cargó en total), Actividad (qué tan activo está) y Antigüedad (hace cuánto es cliente). Estas etiquetas permiten filtrar contactos y crear listas ultra-segmentadas para campañas precisas.',
    steps: [
      {
        title: 'Nivel de monto (seg_monto) — 4 categorías',
        detail:
          'Se calcula sobre el total histórico de cargas de cada jugador usando umbrales fijos:\n• Bajo → menos de $250.000 en cargas históricas\n• Medio → entre $250.000 y $499.999\n• VIP → entre $500.000 y $999.999\n• Super VIP → $1.000.000 o más',
      },
      {
        title: 'Actividad (seg_actividad) — 7 estados',
        detail:
          'Se calcula combinando los días transcurridos desde la última carga y la frecuencia semanal promedio:\n• Nuevo → primera carga hace ≤ 30 días\n• Frecuente → activo + promedio de ≥ 3 cargas por semana\n• Regular → activo + promedio de ≥ 1 carga por semana\n• Ocasional → activo + promedio de < 1 carga por semana\n• En riesgo → última carga hace 31–60 días (sin actividad reciente)\n• Inactivo → última carga hace 61–180 días\n• Perdido → última carga hace más de 180 días (o sin historial)',
      },
      {
        title: 'Antigüedad — 5 niveles',
        detail:
          'Se calcula desde la fecha de la primera carga registrada:\n• Nuevo → cliente desde hace menos de 30 días\n• Reciente → 30–89 días como cliente\n• Establecido → 90–364 días (menos de 1 año)\n• Veterano → 1–3 años como cliente\n• Leal → más de 3 años (1.095+ días)',
      },
      {
        title: 'Valor en riesgo (combinación monto + actividad)',
        detail:
          'Cuando un jugador de alto valor deja de estar activo, se genera automáticamente una etiqueta adicional de alerta:\n• Riesgo crítico → (Perdido / Inactivo / En riesgo) + (Super VIP o VIP)\n• Riesgo medio → (Perdido / Inactivo / En riesgo) + Medio\n• Riesgo bajo → (Perdido / Inactivo / En riesgo) + Bajo\nEstas etiquetas son ideales para campañas de reactivación priorizadas.',
      },
      {
        title: 'Dónde ver y usar la segmentación',
        detail:
          'En el módulo de Contactos podés filtrar por cualquiera de estas dimensiones usando los selectores de "Nivel", "Actividad" y "Antigüedad". Al crear una lista dinámica, podés combinar varios filtros (ej: Nivel = Super VIP + Actividad = En riesgo) para construir audiencias muy específicas para tus campañas.',
      },
    ],
    tips: [
      {
        type: 'info',
        text: 'Los umbrales de Nivel (Bajo / Medio / VIP / Super VIP) son dinámicos: se calculan sobre el percentil del dataset completo cada vez que se corre la segmentación. No son valores fijos en pesos.',
      },
      {
        type: 'example',
        text: 'Ejemplo de campaña de reactivación: filtrás Nivel = VIP o Super VIP + Actividad = En riesgo o Inactivo. Obtenés la lista de tus mejores clientes que dejaron de jugar en los últimos 1–6 meses. Les mandás una oferta exclusiva de bienvenida de vuelta.',
      },
      {
        type: 'example',
        text: 'Ejemplo de campaña de fidelización: filtrás Actividad = Frecuente + Antigüedad = Veterano o Leal. Son tus clientes más fieles y activos. Usá esta lista para recompensas exclusivas o comunicaciones VIP.',
      },
      {
        type: 'warning',
        text: 'La segmentación se actualiza solo cuando se corre el script de importación o re-segmentación. Si un jugador cargó ayer, su estado de actividad no cambia automáticamente hasta la próxima actualización.',
      },
    ],
  },

  {
    id: 'campanas',
    label: 'Campañas',
    icon: Megaphone,
    role: 'both',
    color: 'text-purple-600',
    subtitle: 'Envío masivo de mensajes a listas de contactos',
    description:
      'El módulo de Campañas permite crear y ejecutar envíos masivos de WhatsApp. Podés seleccionar una lista de contactos, elegir el mensaje (usando una plantilla o escribiéndolo en el momento), configurar el horario y el ritmo de envío para evitar bloqueos.',
    steps: [
      {
        title: 'Crear una nueva campaña',
        detail:
          'Hacé clic en "Nueva campaña". Elegí un nombre descriptivo (ej: "Promo Mayo - Clientes VIP"). Seleccioná la lista de destinatarios. Si no tenés una lista, primero andá a Contactos a crearla.',
      },
      {
        title: 'Seleccionar la línea de envío',
        detail:
          'Elegí qué número de WhatsApp va a enviar los mensajes. Si tenés múltiples líneas, podés distribuir el envío entre varias para reducir el riesgo de bloqueo. Usá solo líneas con buen estado de calentamiento.',
      },
      {
        title: 'Escribir el mensaje',
        detail:
          'Podés escribir el mensaje directamente o elegir una plantilla guardada. Usá variables para personalización: {{nombre}} se reemplaza automáticamente con el nombre del contacto. También podés adjuntar imágenes, PDFs o archivos de audio.',
      },
      {
        title: 'Configurar el ritmo de envío',
        detail:
          'Define el delay entre mensajes (recomendado: entre 3 y 8 segundos). Un delay más alto es más seguro pero más lento. Para listas grandes, activá el envío distribuido que mezcla los mensajes aleatoriamente.',
      },
      {
        title: 'Programar o enviar ahora',
        detail:
          'Podés iniciar el envío inmediatamente o programarlo para una fecha y hora específica. Hacé clic en "Guardar y programar" para agendar, o "Iniciar ahora" para empezar el envío de inmediato.',
      },
      {
        title: 'Monitorear el progreso',
        detail:
          'Una vez iniciada, la campaña muestra en tiempo real: cuántos mensajes se enviaron, cuántos fallaron y cuál es la tasa de entrega. Podés pausar o cancelar la campaña en cualquier momento.',
      },
    ],
    tips: [
      {
        type: 'warning',
        text: 'Nunca envíes más de 200-300 mensajes por hora desde una misma línea. WhatsApp puede bloquear el número por comportamiento automatizado.',
      },
      {
        type: 'example',
        text: 'Ejemplo: Creás una campaña "Descuento fin de semana" para la lista "Clientes activos" (500 contactos). Mensaje: "Hola {{nombre}}! Este fin de semana tenés 20% de descuento en toda nuestra tienda. Válido sáb y dom. Mostrá este mensaje." Ritmo: 5 segundos entre mensajes. Programás el envío para el viernes a las 18hs.',
      },
      {
        type: 'tip',
        text: 'Antes de enviar a toda la lista, hacé una prueba con un grupo pequeño de 10-20 contactos para verificar que el mensaje se vea bien y las variables se reemplacen correctamente.',
      },
    ],
  },

  {
    id: 'conversaciones',
    label: 'Conversaciones',
    icon: MessageSquare,
    role: 'both',
    color: 'text-teal-600',
    subtitle: 'Bandeja de conversaciones entrantes y escaladas',
    description:
      'En Conversaciones podés ver todos los chats activos que llegaron a tus líneas de WhatsApp. Las conversaciones que un bot no pudo resolver se escalan a un operador humano para atención manual. También podés iniciar conversaciones directamente desde aquí.',
    steps: [
      {
        title: 'Ver las conversaciones pendientes',
        detail:
          'La pestaña "Escaladas" muestra los chats que necesitan atención humana. Aparecen ordenados por antigüedad — las más viejas primero. El número en el badge indica cuántas hay pendientes.',
      },
      {
        title: 'Tomar una conversación',
        detail:
          'Hacé clic en una conversación para abrirla. Podés ver todo el historial del chat, incluyendo los mensajes intercambiados con el bot. Hacé clic en "Asignarme" para tomar la responsabilidad de esa conversación.',
      },
      {
        title: 'Responder al contacto',
        detail:
          'Escribí el mensaje en el campo de texto y presioná Enter o el botón de enviar. Podés usar plantillas de respuesta rápida haciendo clic en el ícono de rayo. También podés adjuntar archivos.',
      },
      {
        title: 'Asignar a otro operador',
        detail:
          'Si la conversación le corresponde a otro operador, hacé clic en "Reasignar" y seleccioná al operador de la lista. Él recibirá una notificación automáticamente.',
      },
      {
        title: 'Resolver la conversación',
        detail:
          'Cuando el cliente quedó satisfecho, hacé clic en "Marcar como resuelta". La conversación pasa al historial y el slot queda libre para nuevas escalaciones.',
      },
    ],
    tips: [
      {
        type: 'tip',
        text: 'Activá las notificaciones del navegador para recibir alertas cuando te asignan una conversación nueva. Las notificaciones aparecen en la campana del encabezado.',
      },
      {
        type: 'info',
        text: 'Las conversaciones se marcan en rojo si llevan más de 2 horas sin respuesta. Priorizalas para mantener una buena experiencia del cliente.',
      },
      {
        type: 'example',
        text: 'Ejemplo de flujo: Un cliente escribe "Quiero hacer una devolución". El bot no sabe cómo manejar eso, escala la conversación. El operador recibe notificación, abre el chat, ve el historial, responde con el proceso de devolución y marca como resuelta.',
      },
    ],
  },

  {
    id: 'lineas',
    label: 'Líneas',
    icon: Activity,
    role: 'both',
    color: 'text-green-600',
    subtitle: 'Gestión de números de WhatsApp conectados',
    description:
      'El módulo de Líneas muestra todos los números de WhatsApp que están conectados a la plataforma. Podés ver el estado de cada línea (conectada, desconectada, en calentamiento), escanear el código QR para conectar nuevos números y monitorear la salud de cada línea.',
    steps: [
      {
        title: 'Ver el estado de las líneas',
        detail:
          'Cada tarjeta muestra: el número de teléfono, el nombre del perfil de WhatsApp, el estado (verde = conectada, rojo = desconectada, naranja = reconectando) y la cantidad de mensajes enviados hoy.',
      },
      {
        title: 'Conectar una nueva línea',
        detail:
          'Hacé clic en "Agregar línea". Se abrirá un panel con un código QR. Abrí WhatsApp en tu celular, andá a Configuración → Dispositivos vinculados → Vincular dispositivo y escaneá el código QR. La línea quedará conectada en segundos.',
      },
      {
        title: 'Reconectar una línea caída',
        detail:
          'Si una línea aparece en rojo, hacé clic en "Reconectar" para que intente restablecer la sesión automáticamente. Si no funciona, usá "Escanear QR" para volver a vincularte con el celular.',
      },
      {
        title: 'Ver el historial de la línea',
        detail:
          'Hacé clic en una línea para ver su historial: mensajes enviados por día, tasa de entrega, errores y alertas. Esto ayuda a detectar si una línea está teniendo problemas antes de que se bloquee.',
      },
    ],
    tips: [
      {
        type: 'warning',
        text: 'Una línea desconectada no puede enviar mensajes. Si tenés campañas programadas que usan esa línea, pausalas hasta que esté reconectada.',
      },
      {
        type: 'tip',
        text: 'Recomendamos tener al menos 2 líneas activas. Si una falla, la otra puede seguir operando mientras resolvés el problema.',
      },
    ],
  },

  {
    id: 'calentamiento',
    label: 'Calentamiento',
    icon: Flame,
    role: 'both',
    color: 'text-orange-600',
    subtitle: 'Warm-up progresivo de líneas nuevas',
    description:
      'Cuando conectás un número de WhatsApp nuevo, no podés empezar a enviar grandes volúmenes de mensajes inmediatamente. WhatsApp detecta comportamiento sospechoso y puede bloquear el número. El módulo de Calentamiento automatiza el proceso de envío progresivo para "madurar" la línea antes de usarla en campañas.',
    steps: [
      {
        title: 'Seleccionar la línea a calentar',
        detail:
          'Elegí la línea nueva que querés calentar. Es recomendable esperar al menos 24 horas después de conectar un número antes de iniciar el calentamiento.',
      },
      {
        title: 'Configurar el plan de calentamiento',
        detail:
          'Definí la duración del calentamiento (recomendado: 7 a 14 días) y el volumen inicial. El sistema empieza con pocos mensajes al día y va aumentando gradualmente el volumen de forma automática.',
      },
      {
        title: 'Seleccionar los contactos de calentamiento',
        detail:
          'Usá contactos reales que puedan responder mensajes (no listas de clientes). Lo ideal son números de tu propio equipo o de prueba. Las respuestas de los destinatarios ayudan a que WhatsApp vea la línea como legítima.',
      },
      {
        title: 'Monitorear el progreso',
        detail:
          'El panel muestra el progreso del calentamiento: día actual, mensajes enviados, respuestas recibidas y el "score" de salud de la línea. Cuando el score llega a verde, la línea está lista para campañas.',
      },
      {
        title: 'Acciones disponibles en cada línea',
        detail: '',
        actions: [
          {
            icon: QrCode,
            label: 'QR — Vincular línea',
            desc: 'Abre el modal para escanear el código QR y conectar (o reconectar) el número. Usalo si la sesión de WhatsApp expiró o cambiaste de dispositivo.',
            color: 'bg-orange-100 text-orange-600',
          },
          {
            icon: TrendingUp,
            label: 'Ver actividad',
            desc: 'Abre el historial de mensajes enviados, errores y métricas por día para esa línea.',
            color: 'bg-blue-100 text-blue-600',
          },
          {
            icon: Pause,
            label: 'Pausar / Reanudar',
            desc: 'Detiene el calentamiento temporalmente sin perder el progreso. Al reanudar, continúa desde el mismo día.',
            color: 'bg-yellow-100 text-yellow-600',
          },
          {
            icon: Trash2,
            label: 'Eliminar',
            desc: 'Quita la línea del módulo de calentamiento de forma permanente. Los mensajes ya enviados quedan en el historial.',
            color: 'bg-red-100 text-red-500',
          },
        ],
      },
    ],
    tips: [
      {
        type: 'warning',
        text: 'No uses una línea en calentamiento para campañas masivas. Hacerlo puede terminar el proceso antes de tiempo y aumentar el riesgo de bloqueo.',
      },
      {
        type: 'info',
        text: 'El proceso de calentamiento es automático. Una vez iniciado, no necesitás hacer nada. Solo monitoreá el progreso cada día o dos.',
      },
      {
        type: 'info',
        text: 'Si la sesión de WhatsApp se desconecta durante el calentamiento (se cierra sesión en el teléfono), usá el botón QR de esa línea para volver a vincularla sin perder el progreso.',
      },
      {
        type: 'warning',
        text: 'Pausar una línea no reinicia el contador de días. Al reanudar, el calentamiento continúa desde donde quedó. Usá pausa para imprevistos cortos; si la pausa es muy larga el historial de actividad se interrumpe y WhatsApp puede "enfriar" la línea.',
      },
      {
        type: 'example',
        text: 'Ejemplo: Comprás un chip nuevo el lunes. Lo conectás a la plataforma, esperás 24hs y arrancás el calentamiento de 10 días. A partir del día 11, la línea tiene un buen historial y está lista para una campaña de 500 mensajes.',
      },
    ],
  },

  {
    id: 'tareas',
    label: 'Tareas (Admin)',
    icon: ClipboardList,
    role: 'admin',
    color: 'text-violet-600',
    subtitle: 'Crear y gestionar tareas para el equipo',
    description:
      'El módulo de Tareas (vista administrador) permite crear, asignar y hacer seguimiento de todas las tareas del equipo. Los administradores pueden ver el estado de todas las tareas, filtrarlas por operador, tipo o prioridad, y cancelar o reasignar tareas según sea necesario.',
    steps: [
      {
        title: 'Crear una tarea nueva',
        detail:
          'Hacé clic en "Nueva tarea". Completá el título, descripción detallada (instrucciones para el operador), tipo de tarea, prioridad (alta/media/baja), fecha límite y fecha de inicio programado. Asigná la tarea a uno o más operadores.',
      },
      {
        title: 'Tipos de tarea disponibles',
        detail:
          'Difusión (para que el operador gestione una campaña), Envío manual (envíos específicos a contactos), Calentamiento (warm-up de líneas), Atención (responder conversaciones escaladas), Seguimiento (contactar un cliente específico), Revisión (auditar campañas o listas) y Otro (tarea libre).',
      },
      {
        title: 'Monitorear el estado',
        detail:
          'La lista de tareas muestra: pendiente (no iniciada), en progreso (operador trabajando) y completada/cancelada. Filtrá por estado para ver solo las urgentes o las demoradas.',
      },
      {
        title: 'Ver el historial de una tarea',
        detail:
          'Hacé clic en cualquier tarea para ver su historial completo: cuándo se creó, cuándo fue iniciada, si fue reasignada y cuándo se completó. Esto sirve para auditorías.',
      },
      {
        title: 'Cancelar o reasignar',
        detail:
          'Si necesitás cambiar el operador asignado, abrí la tarea y usá el botón "Reasignar". Para cancelar una tarea, usá "Cancelar" e ingresá el motivo. El operador recibirá una notificación.',
      },
    ],
    tips: [
      {
        type: 'example',
        text: 'Ejemplo: Querés que tu operador haga un seguimiento de todos los clientes que no respondieron la última campaña. Creás una tarea tipo "Seguimiento" con prioridad alta, fecha límite para el viernes y las instrucciones detalladas en la descripción.',
      },
      {
        type: 'tip',
        text: 'Usá el campo "Notas" para dejar contexto adicional que el operador debe conocer pero que no forma parte de las instrucciones de la tarea.',
      },
    ],
  },

  {
    id: 'mis-tareas',
    label: 'Mis Tareas (Operador)',
    icon: CheckSquare,
    role: 'operator',
    color: 'text-violet-600',
    subtitle: 'Ver y ejecutar las tareas asignadas',
    description:
      'El módulo Mis Tareas es la vista del operador. Acá aparecen solo las tareas que el administrador te asignó a vos. Podés ver el detalle de cada tarea, iniciarlas cuando empezás a trabajar en ellas y marcarlas como completadas cuando terminás.',
    steps: [
      {
        title: 'Ver tus tareas pendientes',
        detail:
          'Al entrar a Mis Tareas verás las tarjetas de KPIs: cuántas tareas tenés pendientes, en progreso, completadas hoy y vencidas. Debajo está la lista completa.',
      },
      {
        title: 'Iniciar una tarea',
        detail:
          'Cuando empezás a trabajar en una tarea, hacé clic en el botón "Iniciar". Esto cambia el estado a "En progreso" y le avisa al administrador que ya empezaste. Siempre iniciá la tarea antes de comenzar el trabajo.',
      },
      {
        title: 'Ver el detalle e instrucciones',
        detail:
          'Hacé clic en "Ver detalle" para ver las instrucciones completas del administrador, el enlace de acceso rápido al módulo relacionado (ej: ir a Campañas), las fechas y el historial.',
      },
      {
        title: 'Usar el acceso rápido',
        detail:
          'Dependiendo del tipo de tarea, verás un botón de acceso rápido: "Ir a Campañas", "Ir a Contactos", "Ir a Conversaciones", etc. Usá ese botón para navegar directamente al módulo donde debés trabajar.',
      },
      {
        title: 'Marcar como completada',
        detail:
          'Cuando terminás el trabajo, hacé clic en "Completar". Se abrirá un cuadro para que escribas un comentario de cierre (opcional pero recomendado). Describí brevemente qué hiciste o el resultado obtenido.',
      },
    ],
    tips: [
      {
        type: 'tip',
        text: 'Siempre iniciá la tarea antes de empezar a trabajar. Así el administrador sabe que ya estás en eso y no te reasigna a otro operador.',
      },
      {
        type: 'info',
        text: 'Recibirás una notificación en la campana cada vez que te asignen una nueva tarea o cuando el administrador haga cambios en alguna de tus tareas.',
      },
      {
        type: 'example',
        text: 'Ejemplo: El admin te asigna "Enviar campaña de seguimiento a lista VIP". Entrás a Mis Tareas, leés las instrucciones, hacés clic en "Iniciar", luego en "Ir a Campañas" y creás la campaña. Al terminar, volvés a Mis Tareas y completás con el comentario "Campaña enviada a 200 contactos. 185 entregados."',
      },
    ],
  },

  {
    id: 'calendario',
    label: 'Calendario',
    icon: CalendarDays,
    role: 'both',
    color: 'text-blue-500',
    subtitle: 'Vista mensual de tareas programadas',
    description:
      'El Calendario muestra todas las tareas distribuidas en un grid mensual, según su fecha de inicio programado y/o fecha límite. Es ideal para planificar la carga de trabajo del equipo y detectar semanas con muchas tareas venciendo.',
    steps: [
      {
        title: 'Navegar por meses',
        detail:
          'Usá las flechas izquierda/derecha para moverte entre meses. El botón "Hoy" te lleva al mes actual. El nombre del mes y el año aparecen en el centro.',
      },
      {
        title: 'Interpretar los puntos de colores',
        detail:
          'Cada punto en un día representa una tarea. El color indica la prioridad: rojo = alta, amarillo = media, verde = baja. El ícono ⚑ indica fecha límite y el ícono ▶ indica inicio programado.',
      },
      {
        title: 'Ver el detalle de un día',
        detail:
          'Hacé clic en cualquier día para abrir el panel de detalle. Verás todas las tareas de ese día con su tipo, prioridad, estado y fechas. Los días con muchas tareas muestran un "+N más" indicador.',
      },
      {
        title: 'Filtrar tareas',
        detail:
          'Usá los filtros de arriba para ver solo las tareas de cierto tipo o prioridad. Los administradores también pueden filtrar por operador específico para ver la carga de trabajo individual.',
      },
      {
        title: 'Ver tareas sin fecha',
        detail:
          'Al final de la página hay una sección "Sin fecha programada" con todas las tareas activas que no tienen fecha asignada. Estas tareas no aparecen en el grid y necesitan ser programadas.',
      },
    ],
    tips: [
      {
        type: 'tip',
        text: 'Revisá el calendario cada lunes para planificar la semana. Si ves un día con muchas tareas venciendo, reorganizá las prioridades con el equipo.',
      },
      {
        type: 'info',
        text: 'Los operadores ven solo sus tareas en el calendario. Los administradores ven las de todo el equipo.',
      },
    ],
  },

  {
    id: 'estadisticas',
    label: 'Estadísticas',
    icon: BarChart2,
    role: 'both',
    color: 'text-indigo-600',
    subtitle: 'Métricas y reportes de rendimiento',
    description:
      'El módulo de Estadísticas ofrece gráficos e indicadores de rendimiento para analizar el desempeño de las campañas, la actividad de las líneas y la productividad del equipo. Los datos se pueden exportar a CSV para análisis externos.',
    steps: [
      {
        title: 'Seleccionar el período de análisis',
        detail:
          'Usá el selector de fechas en la parte superior para elegir el rango que querés analizar: último día, última semana, último mes o rango personalizado.',
      },
      {
        title: 'Leer los KPIs principales',
        detail:
          'Las tarjetas de KPI muestran: mensajes enviados, tasa de entrega, conversaciones resueltas y tareas completadas para el período seleccionado. Los números en verde son mejoras respecto al período anterior.',
      },
      {
        title: 'Analizar los gráficos',
        detail:
          'El gráfico de barras muestra la actividad por día. El gráfico circular muestra la distribución por tipo de campaña o módulo. Pasando el cursor sobre los puntos del gráfico se ven los valores exactos.',
      },
      {
        title: 'Hacer drill-down',
        detail:
          'Hacé clic en cualquier barra del gráfico para ver el detalle de ese día específico: qué campañas se enviaron, qué operadores estuvieron activos y qué tareas se completaron.',
      },
      {
        title: 'Exportar a CSV',
        detail:
          'Hacé clic en "Exportar CSV" para descargar los datos del período seleccionado en formato planilla. Útil para reportes a gerencia o para análisis en Excel.',
      },
    ],
    tips: [
      {
        type: 'example',
        text: 'Ejemplo de análisis: Filtrás el último mes. Ves que los martes tienen el 40% más de mensajes que el resto de la semana. Conclusión: tus campañas de martes funcionan mejor. Planificás las próximas campañas importantes para los martes.',
      },
      {
        type: 'tip',
        text: 'Comparar semana a semana te ayuda a detectar tendencias. Si la tasa de entrega cayó 10%, revisá el estado de las líneas.',
      },
    ],
  },

  {
    id: 'automatizaciones',
    label: 'Automatizaciones / Bots',
    icon: Bot,
    role: 'both',
    color: 'text-cyan-600',
    subtitle: 'Flujos automatizados con n8n',
    description:
      'El módulo de Automatizaciones permite gestionar los bots y flujos de conversación que responden automáticamente a los mensajes entrantes. Está integrado con n8n, una plataforma de automatización sin código. Acá podés ver los flujos activos, activarlos o desactivarlos y ver los logs de ejecución.',
    steps: [
      {
        title: 'Ver los flujos activos',
        detail:
          'La pantalla principal muestra todos los flujos (workflows) configurados. Cada uno tiene: nombre, descripción, estado (activo/inactivo), cuántas veces se ejecutó y la última ejecución.',
      },
      {
        title: 'Activar o desactivar un flujo',
        detail:
          'Usá el switch al lado de cada flujo para activarlo o desactivarlo. Un flujo inactivo no responde a mensajes. Útil para pausar un bot durante mantenimiento o días feriados.',
      },
      {
        title: 'Ver los logs de ejecución',
        detail:
          'Hacé clic en un flujo y luego en "Ver logs" para ver qué mensajes procesó, si hubo errores y cuánto tardó cada ejecución. Los errores aparecen en rojo con el mensaje de error.',
      },
      {
        title: 'Acceder al editor de n8n',
        detail:
          'Si tenés permisos avanzados, el botón "Editar en n8n" te lleva directamente al editor visual donde podés modificar la lógica del bot. Requiere conocimiento de la plataforma n8n.',
      },
    ],
    tips: [
      {
        type: 'info',
        text: 'Si un bot deja de responder, lo primero que debés hacer es revisar los logs. En el 90% de los casos, el log muestra exactamente qué salió mal.',
      },
      {
        type: 'warning',
        text: 'No desactives un flujo sin avisar al equipo. Si el bot de atención se cae, todas las conversaciones llegan directamente a los operadores sin filtrar.',
      },
    ],
  },

  {
    id: 'blacklist',
    label: 'Blacklist Global',
    icon: ShieldOff,
    role: 'both',
    color: 'text-red-600',
    subtitle: 'Números excluidos de todos los envíos',
    description:
      'La Blacklist Global es la lista de números que nunca recibirán mensajes de la plataforma, independientemente de la campaña o lista en la que estén. Incluye automáticamente a los contactos que respondieron "STOP" o "No quiero más mensajes", y permite agregar números manualmente.',
    steps: [
      {
        title: 'Ver los números bloqueados',
        detail:
          'La lista muestra todos los números en la blacklist, la fecha en que fueron agregados y el motivo (opt-out manual, respuesta STOP, o agregado por el administrador).',
      },
      {
        title: 'Agregar un número manualmente',
        detail:
          'Hacé clic en "Agregar a blacklist", ingresá el número en formato internacional y el motivo. Ese número quedará excluido de todos los envíos futuros de inmediato.',
      },
      {
        title: 'Buscar un número específico',
        detail:
          'Usá la barra de búsqueda para verificar si un número está en la blacklist antes de intentar contactarlo. Útil para verificar antes de una campaña importante.',
      },
      {
        title: 'Remover un número de la blacklist',
        detail:
          'Si un contacto solicitó volver a recibir comunicaciones, podés eliminarlo de la blacklist haciendo clic en el ícono de eliminar. El número vuelve a estar activo para futuras campañas.',
      },
    ],
    tips: [
      {
        type: 'warning',
        text: 'Nunca ignores los opt-outs. Enviar mensajes a alguien que dijo STOP es una violación de las políticas de WhatsApp y puede resultar en el bloqueo de tus líneas.',
      },
      {
        type: 'info',
        text: 'La plataforma detecta automáticamente respuestas como "STOP", "NO QUIERO MÁS", "BAJA", "DESUSCRIBIR" y agrega el número a la blacklist sin intervención manual.',
      },
      {
        type: 'example',
        text: 'Ejemplo: Un competidor empieza a spamearte con sus productos y querés que nunca le lleguen tus mensajes (si tenés su número en contactos). Buscás su número, lo agregás a la blacklist con motivo "Competidor - no contactar".',
      },
    ],
  },

  {
    id: 'plantillas',
    label: 'Plantillas',
    icon: FileText,
    role: 'both',
    color: 'text-amber-600',
    subtitle: 'Mensajes predefinidos reutilizables',
    description:
      'Las Plantillas son mensajes predefinidos que podés reutilizar en campañas y respuestas de conversaciones. Ahorran tiempo y garantizan consistencia en la comunicación. Soportan variables como {{nombre}} que se reemplazan automáticamente con los datos del contacto.',
    steps: [
      {
        title: 'Crear una plantilla',
        detail:
          'Hacé clic en "Nueva plantilla". Poné un nombre descriptivo (ej: "Saludo de bienvenida"), elegí la categoría (marketing, atención, seguimiento), escribí el texto y guardá. Podés incluir imágenes o archivos adjuntos.',
      },
      {
        title: 'Usar variables dinámicas',
        detail:
          'Escribí {{nombre}} en el texto para que se reemplace con el nombre del contacto. También podés usar {{empresa}}, {{producto}} u otras variables que hayas configurado. Al enviar, el sistema reemplaza automáticamente todas las variables.',
      },
      {
        title: 'Usar una plantilla en una campaña',
        detail:
          'Al crear una campaña, en el paso de "Mensaje" seleccioná "Usar plantilla" y elegí la que querés. Podés ver una vista previa del mensaje con las variables antes de confirmar.',
      },
      {
        title: 'Usar una plantilla en conversaciones',
        detail:
          'Dentro de una conversación, hacé clic en el ícono de rayo (⚡) para abrir el selector de plantillas. Elegí la que corresponde y el texto se carga automáticamente. Podés editarlo antes de enviar.',
      },
      {
        title: 'Editar o eliminar plantillas',
        detail:
          'Hacé clic en los tres puntos (...) de cualquier plantilla para editarla o eliminarla. Los cambios en una plantilla NO afectan los mensajes ya enviados.',
      },
    ],
    tips: [
      {
        type: 'example',
        text: 'Ejemplo de plantilla de seguimiento: "Hola {{nombre}}! Te escribimos de {{empresa}} para hacer un seguimiento de tu consulta del {{fecha}}. ¿Pudiste resolver tu inquietud? Si necesitás ayuda, estamos disponibles. ¡Saludos!"',
      },
      {
        type: 'tip',
        text: 'Organizá tus plantillas por categoría: Bienvenida, Seguimiento, Soporte, Ventas, Despedida. Con buenas categorías, los operadores encuentran la correcta en segundos.',
      },
    ],
  },

  {
    id: 'usuarios',
    label: 'Usuarios',
    icon: UserCog,
    role: 'admin',
    color: 'text-slate-600',
    subtitle: 'Gestión de administradores y operadores',
    description:
      'El módulo de Usuarios permite crear y gestionar las cuentas de acceso al sistema. Podés crear administradores (acceso total) y operadores (acceso limitado a los módulos que vos les asignés). También podés cambiar contraseñas, desactivar cuentas y ver la actividad de cada usuario.',
    steps: [
      {
        title: 'Crear un nuevo usuario',
        detail:
          'Hacé clic en "Nuevo usuario". Elegí el rol: Administrador (ve y controla todo) u Operador (ve solo lo que le asignás). Completá nombre, email y contraseña temporal. El usuario puede cambiar su contraseña al ingresar por primera vez.',
      },
      {
        title: 'Asignar sectores a un operador',
        detail:
          'Al editar un operador, verás una lista de sectores: Dashboard, Contactos, Campañas, Conversaciones, Líneas, Calentamiento, Tareas, Estadísticas, Automatizaciones, Blacklist, Plantillas. Activá solo los que ese operador necesita. El operador solo verá esos módulos en su sidebar.',
      },
      {
        title: 'Editar o desactivar una cuenta',
        detail:
          'Hacé clic en el ícono de editar (lápiz) para modificar los datos o sectores de un usuario. Para desactivar una cuenta sin eliminarla, usá el switch "Activo/Inactivo". El usuario no podrá iniciar sesión mientras esté inactivo.',
      },
      {
        title: 'Ver actividad reciente',
        detail:
          'Hacé clic en un usuario para ver su historial de actividad: cuándo inició sesión, qué acciones realizó y qué tareas completó. Útil para auditorías.',
      },
    ],
    tips: [
      {
        type: 'example',
        text: 'Ejemplo: Tenés un operador nuevo que se va a encargar solo de atender conversaciones y completar tareas de seguimiento. Le creás la cuenta con rol Operador y le asignás los sectores: Conversaciones y Tareas. Solo esos módulos aparecerán en su menú.',
      },
      {
        type: 'warning',
        text: 'Nunca compartas contraseñas entre usuarios. Cada persona debe tener su propia cuenta para que el sistema de auditoría funcione correctamente.',
      },
      {
        type: 'tip',
        text: 'Usá el campo de nombre completo para que el sistema muestre "Atendido por: Juan Pérez" en las conversaciones y logs. Facilita saber quién hizo qué.',
      },
    ],
  },

  {
    id: 'ajustes',
    label: 'Ajustes',
    icon: Settings,
    role: 'admin',
    color: 'text-gray-600',
    subtitle: 'Configuración general de la plataforma',
    description:
      'El módulo de Ajustes centraliza la configuración global del sistema: integraciones con servicios externos, configuración de notificaciones, parámetros de las líneas de WhatsApp y personalización de la plataforma para tu empresa.',
    steps: [
      {
        title: 'Configurar notificaciones',
        detail:
          'En la sección de notificaciones podés activar o desactivar qué tipos de alertas recibís: nuevas conversaciones, tareas asignadas, campañas finalizadas, etc. También podés configurar notificaciones por email para alertas críticas.',
      },
      {
        title: 'Parámetros de envío globales',
        detail:
          'Configurá el delay mínimo entre mensajes, el horario permitido de envío (ej: solo de 8hs a 22hs) y el límite diario por línea. Estos parámetros aplican a todas las campañas por defecto.',
      },
      {
        title: 'Integraciones',
        detail:
          'Conectá la plataforma con servicios externos: CRM, herramientas de análisis, webhooks personalizados. Cada integración tiene su propia sección con los campos de configuración necesarios.',
      },
    ],
    tips: [
      {
        type: 'tip',
        text: 'Configurá el horario de envío para que coincida con los horarios de atención de tu empresa. Evitá enviar mensajes de madrugada aunque las campañas estén programadas.',
      },
    ],
  },
]

// ── Tip components ────────────────────────────────────────────────────────────

const TIP_CONFIG = {
  tip:     { icon: Lightbulb,     bg: 'bg-blue-50 border-blue-200',   text: 'text-blue-800',   label: 'Consejo' },
  warning: { icon: AlertTriangle, bg: 'bg-amber-50 border-amber-200', text: 'text-amber-800',  label: 'Atención' },
  info:    { icon: Info,          bg: 'bg-slate-50 border-slate-200', text: 'text-slate-700',  label: 'Info' },
  example: { icon: Star,          bg: 'bg-green-50 border-green-200', text: 'text-green-800',  label: 'Ejemplo' },
}

function TipBox({ tip }: { tip: Tip }) {
  const cfg  = TIP_CONFIG[tip.type]
  const Icon = cfg.icon
  return (
    <div className={`flex gap-2.5 border rounded-lg p-3 ${cfg.bg}`}>
      <Icon size={15} className={`shrink-0 mt-0.5 ${cfg.text}`} />
      <div>
        <span className={`text-[11px] font-semibold uppercase tracking-wide ${cfg.text} mr-1.5`}>
          {cfg.label}:
        </span>
        <span className={`text-sm ${cfg.text}`}>{tip.text}</span>
      </div>
    </div>
  )
}

// ── Role badge ────────────────────────────────────────────────────────────────

function RoleBadge({ role }: { role: Role }) {
  if (role === 'admin')    return <Badge className="bg-violet-100 text-violet-700 text-[11px]">Solo Admin</Badge>
  if (role === 'operator') return <Badge className="bg-teal-100 text-teal-700 text-[11px]">Solo Operador</Badge>
  return (
    <div className="flex gap-1">
      <Badge className="bg-violet-100 text-violet-700 text-[11px]">Admin</Badge>
      <Badge className="bg-teal-100 text-teal-700 text-[11px]">Operador</Badge>
    </div>
  )
}

// ── Module section ────────────────────────────────────────────────────────────

function ModuleSection({ mod, defaultOpen }: { mod: ModuleSection; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const Icon = mod.icon

  return (
    <div id={mod.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm scroll-mt-4">
      {/* Header */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-gray-50 transition-colors"
      >
        <div className={`p-2 rounded-lg bg-gray-100 ${mod.color}`}>
          <Icon size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-gray-900 text-sm">{mod.label}</span>
            <RoleBadge role={mod.role} />
          </div>
          <p className="text-xs text-gray-500 mt-0.5">{mod.subtitle}</p>
        </div>
        {open
          ? <ChevronDown size={16} className="text-gray-400 shrink-0" />
          : <ChevronRight size={16} className="text-gray-400 shrink-0" />
        }
      </button>

      {/* Body */}
      {open && (
        <div className="px-5 pb-5 border-t border-gray-100">
          {/* Description */}
          <p className="text-sm text-gray-700 leading-relaxed mt-4 mb-5">{mod.description}</p>

          {/* Steps */}
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">
            Cómo usar este módulo
          </h3>
          <ol className="space-y-3 mb-5">
            {mod.steps.map((step, i) => (
              <li key={i} className="flex gap-3">
                <span className="shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center mt-0.5">
                  {i + 1}
                </span>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-gray-800">{step.title}</p>
                  {step.actions ? (
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      {step.actions.map((a, j) => {
                        const Icon = a.icon
                        return (
                          <div key={j} className="flex items-start gap-2.5 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2.5">
                            <div className={`shrink-0 w-7 h-7 rounded-md flex items-center justify-center ${a.color ?? 'bg-gray-200 text-gray-600'}`}>
                              <Icon size={14} />
                            </div>
                            <div>
                              <p className="text-xs font-semibold text-gray-700 leading-tight">{a.label}</p>
                              <p className="text-[11px] text-gray-500 leading-relaxed mt-0.5">{a.desc}</p>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <p className="text-sm text-gray-600 mt-0.5 leading-relaxed">{step.detail}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>

          {/* Tips */}
          {mod.tips.length > 0 && (
            <>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">
                Consejos y ejemplos
              </h3>
              <div className="space-y-2">
                {mod.tips.map((tip, i) => <TipBox key={i} tip={tip} />)}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── TOC link ──────────────────────────────────────────────────────────────────

function TocLink({ mod, active }: { mod: ModuleSection; active: boolean }) {
  const Icon = mod.icon
  return (
    <a
      href={`#${mod.id}`}
      className={cn(
        'flex items-center gap-2 px-2 py-1.5 rounded-md text-xs font-medium transition-colors',
        active
          ? 'bg-blue-50 text-blue-700'
          : 'text-gray-500 hover:text-gray-800 hover:bg-gray-100',
      )}
    >
      <Icon size={13} className={`shrink-0 ${active ? 'text-blue-600' : mod.color}`} />
      <span className="truncate">{mod.label}</span>
    </a>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AyudaPage() {
  const { user: currentUser } = useCurrentUser()
  const isAdmin    = currentUser?.role === 'admin'
  const [activeId, setActiveId] = useState<string>(MODULES[0].id)
  const [search,   setSearch]   = useState('')

  // Filter modules by role and search
  const visibleModules = MODULES.filter(mod => {
    if (!isAdmin && mod.role === 'admin') return false
    if (isAdmin   && mod.role === 'operator') return false  // admins don't need operator view
    if (search) {
      const q = search.toLowerCase()
      return (
        mod.label.toLowerCase().includes(q) ||
        mod.subtitle.toLowerCase().includes(q) ||
        mod.description.toLowerCase().includes(q) ||
        mod.steps.some(s => s.title.toLowerCase().includes(q) || s.detail.toLowerCase().includes(q))
      )
    }
    return true
  })

  // Intersection observer to highlight TOC
  const observerRef = useRef<IntersectionObserver | null>(null)
  useEffect(() => {
    observerRef.current?.disconnect()
    observerRef.current = new IntersectionObserver(
      entries => {
        const visible = entries.filter(e => e.isIntersecting)
        if (visible.length > 0) {
          setActiveId(visible[0].target.id)
        }
      },
      { rootMargin: '-20% 0px -70% 0px', threshold: 0 }
    )
    MODULES.forEach(mod => {
      const el = document.getElementById(mod.id)
      if (el) observerRef.current?.observe(el)
    })
    return () => observerRef.current?.disconnect()
  }, [])

  return (
    <div>
      <PageHeader
        title="Guía de uso"
        description="Documentación completa de todos los módulos de la plataforma"
        actions={
          <div className="flex items-center gap-2">
            <BookOpen size={14} className="text-gray-400" />
            <span className="text-xs text-gray-500">
              {visibleModules.length} módulos disponibles para tu rol
            </span>
          </div>
        }
      />

      {/* Intro card */}
      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-100 rounded-xl p-4 mb-6 flex items-start gap-3">
        <HelpCircle size={20} className="text-blue-600 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-blue-900 mb-1">
            {isAdmin
              ? 'Guía para Administradores'
              : 'Guía para Operadores'}
          </p>
          <p className="text-sm text-blue-800 leading-relaxed">
            {isAdmin
              ? 'Esta guía cubre todos los módulos de la plataforma desde la perspectiva del administrador. Incluye cómo configurar el sistema, gestionar el equipo y monitorear el rendimiento.'
              : 'Esta guía explica cómo usar los módulos a los que tenés acceso. Si necesitás acceder a un módulo que no ves en el menú, contactá a tu administrador para que te asigne ese sector.'}
          </p>
          {!isAdmin && (
            <p className="text-xs text-blue-600 mt-2 flex items-center gap-1">
              <ArrowRight size={11} /> Si no ves un módulo en el menú, es porque tu administrador aún no te asignó ese sector.
            </p>
          )}
        </div>
      </div>

      <div className="flex gap-6 items-start">

        {/* ── Left TOC (sticky, desktop only) ──────────────────────────────── */}
        <nav className="hidden lg:flex flex-col gap-0.5 w-48 shrink-0 sticky top-4 self-start bg-white border border-gray-200 rounded-xl p-3 shadow-sm">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 px-2 mb-1">
            Módulos
          </p>

          {/* Search */}
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar..."
            className="w-full text-xs px-2 py-1.5 border border-gray-200 rounded-md mb-1 outline-none focus:border-blue-300"
          />

          {visibleModules.map(mod => (
            <TocLink key={mod.id} mod={mod} active={activeId === mod.id} />
          ))}

          {search && visibleModules.length === 0 && (
            <p className="text-xs text-gray-400 px-2 py-2">Sin resultados</p>
          )}
        </nav>

        {/* ── Main content ──────────────────────────────────────────────────── */}
        <div className="flex-1 min-w-0 space-y-3">

          {/* Mobile search */}
          <div className="lg:hidden mb-3">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar en la guía..."
              className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg outline-none focus:border-blue-300"
            />
          </div>

          {visibleModules.length === 0 ? (
            <div className="py-16 text-center">
              <HelpCircle size={40} className="mx-auto mb-3 text-gray-200" />
              <p className="text-gray-400 text-sm">No se encontraron módulos para "{search}"</p>
            </div>
          ) : (
            visibleModules.map((mod, idx) => (
              <ModuleSection
                key={mod.id}
                mod={mod}
                defaultOpen={idx === 0}
              />
            ))
          )}

          {/* Footer */}
          <div className="text-center py-8 text-xs text-gray-400">
            <p>¿Tenés alguna duda que no está cubierta en esta guía?</p>
            <p className="mt-1">
              {isAdmin
                ? 'Contactá al equipo de soporte técnico.'
                : 'Consultale a tu administrador.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
