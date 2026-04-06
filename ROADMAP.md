# ROADMAP — WhatsApp Automation Platform

## Estado actual
> Última actualización: 2026-04

---

## ✅ Fase 0 — Fundación (completado)
- [ ] Repositorio inicializado con estructura base
- [ ] Convenciones de nombres definidas
- [ ] Schema inicial de base de datos
- [ ] Entorno n8n operativo

---

## 🔄 Fase 1 — MVP de comunicaciones (en progreso)
**Objetivo:** Flujos básicos operativos de onboarding y soporte

- [ ] Workflow: Bienvenida a nuevo jugador
- [ ] Workflow: Verificación de identidad (KYC trigger)
- [ ] Workflow: Notificación de depósito confirmado
- [ ] Workflow: Notificación de retiro procesado
- [ ] Workflow: Respuesta a consultas frecuentes (FAQ bot)
- [ ] Sistema de plantillas de mensajes v1
- [ ] Logging básico de eventos en DB

---

## 📋 Fase 2 — Retención y CRM
**Objetivo:** Automatizar acciones de retención y segmentación

- [ ] Workflow: Jugador inactivo (D+3, D+7, D+14)
- [ ] Workflow: Oferta de bono personalizado
- [ ] Workflow: Recordatorio de bono por vencer
- [ ] Workflow: Cumpleaños del jugador
- [ ] Segmentación por nivel de jugador (casual / regular / VIP)
- [ ] Dashboard de métricas de retención

---

## 📋 Fase 3 — Risk & Compliance
**Objetivo:** Alertas automáticas y controles operativos

- [ ] Workflow: Alerta de retiro superior a umbral
- [ ] Workflow: Detección de patrones de bonus abuse
- [ ] Workflow: Jugador con múltiples cuentas (flag)
- [ ] Workflow: Reporte diario de operaciones para compliance
- [ ] Integración con blacklist interna

---

## 📋 Fase 4 — Reportería y Operaciones
**Objetivo:** Visibilidad operativa completa

- [ ] Reporte diario automático por WhatsApp/email
- [ ] Reporte semanal de KPIs
- [ ] Export CSV de transacciones del día
- [ ] Alertas de sistema (downtime, errores críticos)
- [ ] Panel de salud de workflows

---

## 💡 Backlog / Ideas futuras
- Integración con LiveChat para escalado de soporte
- A/B testing de plantillas de mensajes
- Modelo predictivo de churn
- Soporte multi-idioma (ES / PT)
- WhatsApp flows interactivos (botones, listas)

---

## Notas
- Priorizar flujos con mayor impacto en conversión y retención
- Cada workflow debe tener su spec funcional en `/docs/workflows/` antes de implementar
- Los cambios de schema requieren migración numerada en `/db/migrations/`
