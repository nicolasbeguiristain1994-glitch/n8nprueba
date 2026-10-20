# Protección de campañas y alertas de riesgo

La protección pausa los nuevos envíos cuando detecta una señal oficial de Meta o
un patrón preventivo del panel. No predice con certeza una suspensión, no calcula
una probabilidad de baneo y no reemplaza el consentimiento ni las políticas de
WhatsApp. Una BAJA no es una denuncia de spam.

## Señales y alcance

Las señales se registran con fuente, momento observado, motivo, métricas y alcance:
campaña, cuenta WABA, línea o plantilla. Una restricción compartida bloquea las
campañas que usan el recurso afectado; cambiar de línea o reintentar destinatarios
no debe eludir el bloqueo. Los eventos oficiales provienen de webhooks firmados o
consultas autenticadas a Meta. Una señal oficial activa no se levanta con una nota
del operador.

La calidad amarilla o roja de una línea o plantilla activa una pausa preventiva;
también los estados y errores oficiales de restricción. La consulta `health_status`
detecta recursos BLOCKED, incluso si el bloqueo precede al despliegue; LIMITED
por sí solo no se interpreta como riesgo de suspensión. El servidor vuelve a
consultar la calidad periódicamente cada tres minutos y antes de enviar, con una
vigencia máxima de un minuto para la observación reutilizada. Una consulta fallida
impide continuar hasta poder verificar de nuevo. **Actualizar estado** en el
detalle vuelve a ejecutar esa comprobación; la recuperación de Meta no reanuda
una campaña por sí sola.

Los controles internos usan una ventana móvil de las últimas 24 horas, acotada
también por la última revisión registrada de la campaña. Deben cumplirse todas
las condiciones de la fila correspondiente:

| Control preventivo | Muestra mínima | Cantidad mínima | Proporción mínima |
| --- | --- | --- | --- |
| Bajas atribuidas a la campaña | 50 destinatarios con entrega confirmada | 5 bajas | 5% de los entregados |
| Rechazos de Meta `131049` | 50 intentos aceptados o fallidos | 10 rechazos `131049` | 20% de esos intentos |

Estos valores son decisiones conservadoras del producto, no límites de seguridad
ni umbrales de sanción publicados por Meta. El código `131049` tampoco acredita
una denuncia. Los códigos `131026` (no entregable) y `130472` (experimento del
proveedor) no disparan el control de riesgo `131049`. No se debe convertir todo
fallo de entrega en supuesto riesgo de baneo ni reintentar automáticamente un
resultado incierto del proveedor.

## Qué ocurre al detectar riesgo

1. Se conserva un incidente persistente y se pausa la campaña con
   `pause_reason='risk_detected'`. Los pendientes conservan su historial.
2. Se generan alertas internas persistentes para el responsable activo y los
   administradores activos, sin duplicar al mismo destinatario por incidente.
3. Campañas muestra un aviso visible con acceso al motivo, origen, hora y
   evidencia. La página visible actualiza campañas cada 15 segundos; la campana
   de notificaciones mantiene su propia consulta periódica.
4. Se bloquean los caminos de inicio, reanudación, programación, reintento y
   reinicio mientras exista una alerta sin revisar. Liberar un procesador
   bloqueado no equivale a resolver el riesgo.

El incidente es independiente del texto del motivo de pausa: cambiar ese texto
o el estado de la campaña no elimina la protección. Los mensajes ya aceptados
por WhatsApp pueden terminar de entregarse; una pausa no puede retirarlos. Un
envío que ya estaba en curso puede completar su respuesta del proveedor.

La alerta en el panel no equivale a un correo, SMS, notificación móvil o aviso de
WhatsApp. Esos canales requieren una integración y destino configurados. Cerrar
el navegador no desactiva la protección del servidor, pero impide ver los avisos
de la interfaz hasta volver a abrirla.

## Revisar y continuar

Abrir **Revisar alerta**, contrastar el estado actual y corregir la causa. Revisar
la autorización y relevancia de la audiencia, identificación de la marca,
contenido de la oferta y atención posterior. No cambiar números para esquivar
una restricción.

El responsable o un administrador necesita permisos de edición de campañas y
envío para registrar la revisión. Debe dejar una nota de 10 a 2000 caracteres.
La revisión incluye los identificadores exactos que mostró la pantalla: una
alerta nueva o concurrente obliga a actualizar antes de continuar. Una señal de
Meta todavía activa mantiene el bloqueo.

**Registrar revisión no inicia envíos.** Cuando corresponda, usar **Reanudar**
como acción separada. La nota y el responsable quedan en el historial; los nuevos
eventos siguen evaluándose. No borrar incidentes ni modificar tablas a mano para
reactivar una campaña.

## Validación y publicación

Seguir [Publicaciones verificadas](verified-releases.md). La validación local y
GitHub Actions ejecutan `campaign-risk-postgres.test.ts` con PostgreSQL 17,
además de las pruebas de rutas, interfaz y controles de envío. La suite PostgreSQL
usa `RUN_CAMPAIGN_PG_TESTS=1` y `DATABASE_URL` local, rechaza servidores remotos y
crea un esquema independiente con datos sintéticos.

Aplicar únicamente migraciones del catálogo verificado. Los incidentes y señales
no se exponen a clientes de la Data API: deben conservar RLS y permisos internos.
Comprobar índices de deduplicación y compatibilidad antes de habilitar envíos.
Las pruebas de integración simulan Meta; nunca deben enviar WhatsApp reales.

Consultar [Respaldos y recuperación](database-backup-restore.md) para la copia
privada previa a cambios de esquema y su comprobación en PostgreSQL local. La
copia de Git no contiene los datos. Nunca restaurar una copia sobre producción
como parte de la validación ni publicar secretos o respaldos con el artefacto.

Después del despliegue, comprobar `/release.json`, recepción de eventos, acceso
del responsable y administradores al detalle de riesgo, y persistencia de una
pausa de prueba sintética. Verificar también que un usuario ajeno no pueda leer
ni resolver la alerta. No provocar una restricción real ni enviar mensajes a
clientes para probar el control.
