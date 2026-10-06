# Respuesta con línea asignada — Ofizeus

Base de producción: `a788b2e594fd9e8330b3a769d94a2afb51c84932`. Solicitud del 06/10: responder al botón «Más info» con la línea de atención del contacto. El usuario confirmó alcance exclusivo al agente `ofizeus`, línea principal sin variante, OFI con variante `a`, y aviso de asesor cuando no hay correspondencia activa.

El directorio en `frontend/lib/contact-line-directory.ts` contiene las 16 correspondencias provistas. Se responde por la línea donde llegó el mensaje, enviando el nombre y número en el formato confirmado por el usuario, por ejemplo `ZEUS 3 549 | 1154 | 726043`, sin enlace ni número completo adicional. El cambio de formato no garantiza evitar restricciones del proveedor. No se envía desde ese número ni se crean credenciales.

Modo optativo en una regla reply: `action_config.contact_line_directory="ofizeus"`. Conserva el modo al editar la introducción en Automatizaciones. La regla nueva usa coincidencia exacta normalizada «Más info» y prioridad 1, con preferencia sobre la genérica de igual prioridad. La regla anterior EXTRA/Más info permanece intacta, incluida su restricción de una respuesta por chat, y continúa como antes para otros agentes. La nueva respuesta permite solicitudes posteriores; el mismo webhook se deduplica y clics repetidos en diez segundos se limitan. Una respuesta EXTRA anterior no bloquea inmediatamente la consulta de línea.

Sólo usa contactos no eliminados y el agente primario. Dos registros con el mismo teléfono, un contacto desconocido, asignaciones faltantes, variantes B o líneas fuera del directorio reciben: «Gracias por escribirnos. Un asesor te atenderá para indicarte tu línea correspondiente.» Se marca la conversación para atención humana. Se mantienen bajas, conversaciones ya atendidas, reglas pausadas, creador activo, ventana de respuesta y línea emisora habilitada.

Los pasos se persisten antes del envío y se conserva el control de resultados inciertos. Las pruebas simulan al proveedor: no disparan mensajes a clientes reales. No requiere cambios de esquema. Antes de activar: respaldar automatizaciones, publicar por el ejecutor y CI, verificar identidad, crear únicamente la regla revisada y revalidar configuración. No reproducir clics históricos ni reactivar trabajos anteriores.

Recuperación: pausar exclusivamente la nueva regla. Conservar logs y trabajos; la automatización anterior no se modifica. Revertir aplicación requiere un commit nuevo por el ejecutor verificado.

## Variable editable

La respuesta admite `{{2}}` (también con espacios internos), reemplazado por el número agrupado de la línea correspondiente. Sólo inserta el número en cada aparición, sin nombre de línea ni pie adicional. Conserva saltos de línea, emojis y las variables existentes. Los mensajes de la versión anterior sin `{{2}}` conservan su pie automático hasta ser editados.

En Automatizaciones, agregar `{{2}}` a una respuesta activa el directorio Ofizeus al guardar. Se muestra una vista previa etiquetada como ejemplo de línea 3A. La automatización existente de Más info permanece activa; se actualiza su mensaje con el ejemplo exacto del usuario, respaldando primero su configuración. No se alteran desencadenantes, frecuencia, prioridad ni las otras reglas.
