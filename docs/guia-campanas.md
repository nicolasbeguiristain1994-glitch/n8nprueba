# Guía de uso — Módulo de Campañas

## ¿Qué es una campaña?

Una campaña es un envío masivo de mensajes WhatsApp a una lista de contactos. Podés enviar texto plano, mensajes con imagen/video, y hasta 10 variantes del mismo mensaje para que cada contacto reciba una versión diferente (anti-spam).

**Ejemplo real:** Querés avisarle a 500 clientes que hay una promoción. Creás una campaña, la apuntás a tu lista "Clientes activos" y la plataforma distribuye los mensajes entre tus líneas WhatsApp con delays humanizados para evitar bloqueos.

---

## Antes de empezar

Para poder lanzar una campaña necesitás tener configurados:

- **Al menos una línea WhatsApp activa y conectada** (status = active, is_connected = true)
- **Una lista de contactos** con al menos un contacto que tenga `opt_in_marketing = true`

Si no tenés ninguna de las dos cosas, la campaña va a pausarse sola apenas arranque.

---

## Crear una campaña

### Campos obligatorios

| Campo | Qué es | Ejemplo |
|-------|--------|---------|
| **Nombre** | Identificador interno | `Promo Mayo 2026` |
| **Mensaje** | Texto que recibe el contacto | `Hola {{nombre}}, tenemos una oferta especial para vos 🎁` |
| **Lista** | A quiénes se lo enviás | `Clientes activos` |

### Campos opcionales importantes

| Campo | Por defecto | Cuándo usarlo |
|-------|-------------|---------------|
| **Variantes de mensaje** | 1 mensaje | Cuando querés rotar textos para sonar más natural |
| **Imagen / Video** | Sin media | Para campañas visuales (productos, banners) |
| **Programar envío** | Inmediato | Si querés que salga a un horario específico |
| **Personalizar nombre** | Activado | Desactivalo si el mensaje no usa `{{nombre}}` |
| **Multi-línea** | Desactivado | Activalo si tenés varias líneas y querés mayor velocidad |
| **Perfil Anti-Ban** | Meta-Stealth-2026 | Cambialo solo si la campaña lo justifica (ver sección Anti-Ban) |
| **Tipo de Delay** | Gaussiano | Ajustalo según el nivel de riesgo aceptado |
| **Delay base** | 18 segundos | Bajalo para urgencia, subilo para mayor protección |
| **Límite diario por línea** | Sin límite extra | Restringí cuánto puede enviar cada línea en esta campaña |
| **Mini-sesión** | Desactivado | Activalo para simular una conversación real con un seguimiento corto |

### El placeholder `{{nombre}}`

Si tenés "Personalizar nombre" activado, la plataforma reemplaza `{{nombre}}` con el nombre real del contacto.

```
Mensaje configurado:  "Hola {{nombre}}, te enviamos tu resumen mensual"
Lo que recibe María:  "Hola María, te enviamos tu resumen mensual"
Lo que recibe Carlos: "Hola Carlos, te enviamos tu resumen mensual"
```

Si el contacto no tiene nombre cargado, queda `{{nombre}}` tal cual — por eso es recomendable tener los datos completos en la lista.

### Variantes de mensaje (hasta 10)

En lugar de un solo mensaje, podés configurar varias versiones. La plataforma las distribuye al azar entre los contactos.

```
Variante 1: "Hola {{nombre}}! Tenemos algo especial para vos 🎁"
Variante 2: "{{nombre}}, no te pierdas nuestra promo de mayo 👀"
Variante 3: "Buenas! Entrá y mirá lo que armamos para este mes ✨"
```

Esto hace que el tráfico parezca más orgánico y reduce el riesgo de detección como spam.

---

## Los estados de una campaña

```
[borrador] → [programada] → [en curso] → [completada]
                                ↓
                           [pausada] → [en curso]  (reanudación)
                                ↓
                           [cancelada]
```

### Borrador
Recién creada. Podés editarla antes de enviar.

### Programada
Tiene fecha de envío configurada en el futuro. Se activa sola cuando llega el momento.

### En curso
Está enviando mensajes ahora. Podés ver el progreso en tiempo real.

### Pausada
Se detuvo. Puede ser por decisión tuya o automáticamente. Siempre muestra el **motivo**:

| Motivo | Qué significa | Qué hacer |
|--------|--------------|-----------|
| `manual` | La pausaste vos | Reanudar cuando quieras |
| `no_eligible_lines` | Ninguna línea tiene cupo hoy | Esperar al día siguiente o agregar más líneas |
| `all_lines_outside_schedule` | Las líneas no están en horario activo | Esperar a que entren en horario |
| `frequency_exhausted` | Todos los contactos ya recibieron mensaje en las últimas 24–48hs | Esperar o hacer reset (solo admin) |
| `systemic_error` | Error técnico en el processor | Revisar logs o contactar admin |
| `config_missing` | Falta la API key de Evolution | Configurar credenciales |

### Completada
Todos los contactos fueron procesados (enviados, fallidos o saltados). Solo lectura.

### Cancelada
Terminal. No se puede revertir ni reanudar.

---

## Enviar una campaña

### Modo simple (una línea)
Usa n8n para gestionar el envío. Más simple, menos escalable.

1. Abrí la campaña
2. Hacé clic en **Enviar**
3. La plataforma elige la línea activa disponible y empieza a mandar

### Modo multi-línea (recomendado para listas grandes)
Distribuye los mensajes entre todas las líneas activas al mismo tiempo, mucho más rápido.

1. Al crear la campaña activá **"Distribución multi-línea"**
2. Hacé clic en **Despachar**
3. La plataforma elige la mejor línea para cada mensaje usando un sistema de ponderación (las líneas con más cupo disponible tienen mayor probabilidad de ser seleccionadas)

**Ejemplo:** Tenés 3 líneas con capacidad 200, 150, y 50 mensajes restantes. La línea de 200 va a recibir aproximadamente el 57% de los envíos, la de 150 el 43%, y la de 50 va a ir quedando fuera a medida que se agote.

---

## Pausar y reanudar

### Pausar manualmente
Hacé clic en **Pausar** desde la campaña en curso. Los mensajes que ya estaban en vuelo terminan, los pendientes se guardan para cuando reanudes.

### Reanudar
Hacé clic en **Reanudar** (o **Despachar** en modo multi-línea). La campaña continúa exactamente desde donde se quedó — no re-envía a contactos que ya recibieron el mensaje.

---

## Reintentar mensajes fallidos

Si algunos mensajes fallaron (número inválido, línea caída momentáneamente, etc.), podés reintentar **solo esos** sin tocar los que ya llegaron.

1. Abrí la campaña completada o pausada
2. Hacé clic en **Reintentar fallidos**
3. La plataforma resetea los fallidos a "pendiente" y vuelve a intentar

Los contactos que ya recibieron el mensaje no se ven afectados.

---

## Métricas que vas a ver

### Durante el envío

```
Enviados   Entregados   Leídos   Fallidos   Saltados
  347 /500    289          142       8          12
```

| Métrica | Qué mide |
|---------|---------|
| **Enviados** | WhatsApp confirmó que recibió el mensaje (✓ simple) |
| **Entregados** | El teléfono del destinatario lo recibió (✓✓ doble) |
| **Leídos** | El contacto lo abrió (✓✓ azul) |
| **Fallidos** | Error definitivo (número inválido, bloqueado, etc.) |
| **Saltados** | Omitido por frecuencia (ya recibió mensaje reciente) o por opt-out |

### Tasas clave

- **Tasa de entrega** = Entregados / Enviados (apuntá a > 90%)
- **Tasa de lectura** = Leídos / Enviados (típico en WhatsApp: 60–80%)

### Desglose por línea (modo multi-línea)

Podés ver cuántos mensajes envió cada línea y si alguna tuvo más errores que las demás. Si una línea tiene tasa de error alta, es señal de que esa instancia necesita revisión.

---

## Configuración Anti-Ban

La sección **Configuración Anti-Ban** del modal de creación te permite controlar exactamente cómo se comporta el envío para minimizar el riesgo de bloqueo en Meta.

### Perfil Anti-Ban

El perfil es el punto de partida. Define el comportamiento general de la campaña. Hay tres perfiles predefinidos:

| Perfil | Para qué líneas | Velocidad | Protección |
|--------|----------------|-----------|-----------|
| **Meta-Stealth-2026** *(por defecto)* | Líneas nuevas o cualquier campaña importante | Lenta | Máxima |
| **Balanced** | Líneas con 30+ días limpios y score > 70 | Media | Alta |
| **Aggressive** | Solo líneas con 90+ días limpios y score ≥ 85 | Rápida | Básica |

> Si no elegís ningún perfil, se usa Meta-Stealth-2026 automáticamente.

### Tipo de Delay

Controla el algoritmo que genera los tiempos entre envíos:

| Tipo | Descripción | Cuándo usarlo |
|------|-------------|---------------|
| **Gaussiano** *(recomendado)* | Los delays siguen una curva de campana — la mayoría cae cerca del centro, con variaciones naturales | Siempre que sea posible |
| **Humano con ruido** | Uniforme base con pausas largas ocasionales para simular distracción | Campañas largas donde la variabilidad extra ayuda |
| **Uniforme** | Delay constante dentro del rango, sin distribución | Solo para líneas muy maduras con perfil Aggressive |

### Delay base (segundos)

Es el valor central alrededor del cual se calculan los delays reales. El algoritmo lo usa como referencia, no como valor fijo.

- **Default: 18s** — equilibrio entre velocidad y seguridad
- Reducirlo (`10s`) acelera la campaña pero aumenta el riesgo
- Aumentarlo (`30s`) es más seguro pero más lento

### Límite diario por línea

Override del límite global de la línea, aplicado **solo a esta campaña**.

```
Línea Celu 1 tiene capacidad para 500 mensajes/día.
Si ponés límite diario = 100 en esta campaña,
esa línea no va a enviar más de 100 mensajes para esta campaña hoy.
```

Útil para reservar capacidad de las líneas en caso de que haya otras campañas corriendo al mismo tiempo. Si lo dejás vacío, la línea usa toda su capacidad disponible.

**Mínimo: 5.** Si ponés un valor menor, la campaña no se va a crear.

### Mini-sesión

Cuando está activado, la plataforma envía un mensaje corto de seguimiento después de cada envío exitoso (por ejemplo: `👍`). Esto simula el inicio de una conversación real, lo que mejora la reputación de la línea frente a Meta.

- El texto de seguimiento es editable (emoji, frase corta, etc.)
- El delay entre el mensaje principal y el seguimiento lo controla el perfil anti-ban
- Solo se envía si el mensaje principal llegó con éxito

### Protección de frecuencia

Independientemente de la configuración anti-ban:

- Un mismo contacto **no puede recibir dos mensajes de la misma campaña**
- Hay un cooldown de **24–48hs entre campañas distintas** para el mismo contacto
- Los contactos en blacklist o sin `opt_in_marketing` se excluyen automáticamente

---

## Campañas vs Secuencias

### Campaña
Envío **masivo, único**, a una lista definida. Vos lo iniciás manualmente (o programado).

**Cuándo usarla:** Promos, avisos, comunicados, recordatorios.

**Ejemplo:** "Enviarle a todos los clientes activos un mensaje sobre la nueva función."

### Secuencia (drip campaign)
Flujo **automático y multi-paso** que se dispara por un evento. El contacto va avanzando por los pasos con delays configurados.

**Cuándo usarla:** Onboarding, retención, recordatorios de pago en fechas específicas.

**Ejemplo:**
```
Trigger: nuevo contacto creado
  → Día 0: "Bienvenido {{nombre}}! Esto es lo que podés hacer..."
  → Día 1: "¿Alguna pregunta? Estamos acá para ayudarte"
  → Día 7: "Ya pasó una semana, ¿cómo te está yendo?"
```

La diferencia clave: una campaña la lanzás vos, una secuencia corre sola para cada contacto que cumple el trigger.

---

## Acciones de administrador

Estas acciones solo están disponibles para usuarios con rol `admin`:

### Reset de frecuencia
Borra el historial de frecuencia de una campaña y resetea todos los contactos a "pendiente". Útil para pruebas cuando querés re-enviar a los mismos contactos sin esperar las 48hs.

**⚠️ No usar en producción con datos reales.**

### Liberar lock
Si el processor se cuelga y la campaña queda "bloqueada" (processor_locked_at > 20 min sin progreso), este botón libera el lock y pausa la campaña para que puedas reanudarla manualmente.

**Cuándo usarlo:** La campaña dice "en curso" pero el contador de enviados no avanza hace más de 20 minutos.

---

## Casos de uso comunes

### Caso 1: Promo flash (urgente, 200 contactos, líneas maduras)
1. Crear campaña con 3 variantes del mensaje
2. Lista: "Clientes activos"
3. Perfil Anti-Ban: **Balanced** (líneas tienen 30+ días limpios)
4. Tipo de delay: Gaussiano · Delay base: 10s
5. Multi-línea: activado
6. Despachar → monitorear en tiempo real

### Caso 2: Comunicado masivo (1.000+ contactos, sin apuro)
1. Crear campaña con mensaje único
2. Lista: "Base completa"
3. Perfil Anti-Ban: **Meta-Stealth-2026** (máxima protección)
4. Tipo de delay: Gaussiano · Delay base: 18s
5. Límite diario por línea: 150 (para no quemar toda la capacidad en un día)
6. Multi-línea: activado
7. Programar para las 10AM del día siguiente
8. La plataforma la lanza sola a esa hora

### Caso 3: Campaña con líneas nuevas (máxima protección)
1. Líneas recién conectadas, menos de 30 días de historia
2. Perfil Anti-Ban: **Meta-Stealth-2026** (no cambiar)
3. Tipo de delay: Gaussiano · Delay base: 25s
4. Mini-sesión: activado con `👍` (mejora reputación de la línea)
5. Límite diario por línea: 50 (arrancar despacio)
6. A medida que las líneas maduran, ir subiendo el límite y pasando a perfil Balanced

### Caso 4: Recuperar fallidos de una campaña anterior
1. Abrir la campaña completada
2. Ver el conteo de fallidos (ej: 23 fallidos de 500)
3. Clic en "Reintentar fallidos"
4. La campaña se reactiva solo para esos 23 contactos

### Caso 5: Campaña pausada por "no_eligible_lines"
- Significa que todas tus líneas llegaron al límite diario de mensajes
- No hay nada roto — es el sistema trabajando como debe
- Al día siguiente las líneas se resetean y podés reanudar
- O podés agregar más líneas al pool para aumentar la capacidad diaria

---

## Preguntas frecuentes

**¿Qué pasa si un contacto está en blacklist?**
No recibe el mensaje. La plataforma lo detecta al cargar la lista y lo excluye automáticamente (aparece como "saltado").

**¿Qué pasa si la campaña se cae a mitad de camino?**
El processor tiene recuperación automática. Los mensajes que quedaron en estado "enviando" por más de 15 minutos son revisados: si WhatsApp los confirmó se marcan como enviados, si no se resetean a pendiente para el próximo intento.

**¿Puedo enviar la misma campaña dos veces?**
No directamente — los contactos que ya recibieron el mensaje tienen status "sent" y no se vuelven a procesar. Para reenviar a todos necesitás un reset de frecuencia (solo admin).

**¿Cuántos contactos puedo incluir en una campaña?**
No hay límite técnico. La velocidad depende de cuántas líneas activas tenés y su capacidad diaria configurada.

**¿Las campañas respetan el horario de las líneas?**
Sí. Cada línea tiene un horario activo configurado (personalidad de línea). Si una línea está fuera de horario, la plataforma la descarta temporalmente y usa las que sí están activas. Si todas están fuera de horario, la campaña se pausa con motivo `all_lines_outside_schedule` y se reanuda sola cuando alguna línea vuelva a estar en horario.
