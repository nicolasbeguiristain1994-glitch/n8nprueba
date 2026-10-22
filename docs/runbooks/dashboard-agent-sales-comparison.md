# Comparativa mensual de ventas por agente

Al elegir Todos los agentes, el dashboard muestra Ventas por agente antes del
bloque de usuarios nuevos. Cada tarjeta muestra depósitos sin bonos, participación
en el total y, debajo del importe, la diferencia en pesos y el porcentaje frente
al mes anterior. Las subas son verdes, las bajas rojas y la igualdad neutra.
Una base anterior de cero con ventas actuales muestra Sin base anterior,
sin inventar un crecimiento del 100%. Los agentes sin ventas siguen visibles.

La comparación respeta la plataforma seleccionada y la identidad canónica de
agente del consolidado. Los importes se agregan en PostgreSQL usando el mismo
ledger de importes originales y separación de bonos que las demás métricas.
Se incluye en la consulta y caché existentes de casino, sin nuevas solicitudes
por tarjeta ni cambios de esquema.

## Períodos

Los límites de la API son días completos inclusivos, en hora argentina.
Primero se convierte el Hasta exclusivo de los filtros personalizados.
Un mes completo se compara con el mes anterior completo: septiembre contra
agosto, incluyendo el 31 de agosto. Un período parcial conserva los números de
día del mes anterior: 1–20 de octubre contra 1–20 de septiembre. Los días que no
existen se ajustan al último día del mes. En rangos que abarcan varios meses se
desplazan ambos límites un mes hacia atrás. La tarjeta siempre muestra las
fechas exactas de ambos períodos.

Las comparaciones anteriores de los KPI de cuentas mantienen sus períodos de
igual duración. La ampliación del ledger no cambia esos resultados.

## Validación

Las pruebas de fechas cubren fin de mes, cambio de año, años bisiestos y Hasta
exclusivo. Las pruebas PostgreSQL verifican bonos, precisión original, alias por
plataforma, límites horarios, agentes con ventas solo en el mes anterior,
denominador cero y conservación de KPI. Se ejecutan también en el flujo de
publicación verificado. Las pruebas de interfaz cubren colores, signos, filtros,
estado sin datos y orden por ventas.

## Carga de las tarjetas

Ventas y usuarios nuevos usan `/api/dashboard/casino/agents`, con la misma
validación de permisos, filtros, fechas y caché acotada del dashboard. La consulta
agrega los movimientos por plataforma y agente antes de resolver los alias; para
los nuevos usuarios lee solo la fecha y el agente del primer depósito. Evita
clasificar a todos los jugadores y preparar rankings para mostrar estas tarjetas.

El cliente inicia esta solicitud primero (también al anticipar la navegación),
publica las tarjetas al resolverla y conserva sus valores durante una actualización
de los mismos filtros. Cambiar fechas, plataforma o agente borra los datos previos
y descarta cualquier respuesta tardía. Se mantienen como máximo dos solicitudes
simultáneas; los demás indicadores siguen cargando progresivamente.

La ruta original conserva su respuesta completa. El cliente pide `details=1`
para los indicadores restantes, con una clave de caché distinta y sin volver a
calcular la comparativa de ventas. No hay migraciones ni cambios en importes,
atribución de primeros depósitos o tiempos máximos de caché.

La integración PostgreSQL contrasta las tarjetas rápidas con el informe completo
en meses completos, períodos parciales, agentes filtrados, cuentas que cambiaron
de agente, alias y agentes ocultos. Las pruebas de interfaz verifican que las
ventas y nuevos usuarios aparecen mientras la consulta detallada sigue pendiente,
y permanecen visibles cuando otros bloques terminan durante una actualización.
