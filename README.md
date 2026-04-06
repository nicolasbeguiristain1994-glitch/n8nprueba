# WhatsApp Automation Platform

Plataforma de automatización de comunicaciones vía WhatsApp para operaciones de iGaming en LATAM.

## Descripción

Sistema de workflows automatizados construido sobre n8n que gestiona el ciclo completo de comunicación con jugadores: onboarding, retención, soporte, alertas de fraude y reportería operativa.

## Stack

- **Orquestación:** n8n (self-hosted)
- **Base de datos:** PostgreSQL (Supabase)
- **Mensajería:** WhatsApp Business API / Evolution API
- **CRM/Backend:** Supabase
- **Scripting auxiliar:** Node.js / Python

## Estructura del repositorio

```
/docs
  /architecture     → Diagramas, decisiones técnicas (ADRs), flujos de datos
  /workflows        → Descripción funcional de cada workflow
  /prompts          → Prompts de IA usados en nodos de LLM
  /runbooks         → Procedimientos operativos (deploy, rollback, incidentes)
/n8n
  /workflow-specs   → Exports JSON de workflows de n8n
  /credentials-template → Plantillas de credenciales SIN valores reales
  /env-examples     → Archivos .env.example con variables documentadas
/db
  /schema           → DDL completo de tablas
  /migrations       → Archivos de migración numerados
  /seeds            → Datos iniciales / fixtures para testing
/scripts
  /imports          → Scripts de carga de datos
  /ops              → Scripts de operaciones y mantenimiento
/src
  /helpers          → Funciones utilitarias reutilizables
  /validators       → Validación de datos entrantes
  /templating       → Motor de plantillas de mensajes
  /reporting        → Generación de reportes y exports
```

## Qué NO está en este repo

- Credenciales reales
- Tokens de API (WhatsApp, Supabase, proveedores)
- Archivos `.env` productivos
- Datos de jugadores

Ver `/n8n/credentials-template/` y `/n8n/env-examples/` para estructura esperada de configuración.

## Setup rápido

```bash
# 1. Clonar el repo
git clone https://github.com/TU_USUARIO/whatsapp-automation-platform.git

# 2. Copiar y completar variables de entorno
cp n8n/env-examples/.env.example .env

# 3. Importar workflows en n8n
# En n8n UI: Settings → Import → seleccionar archivos de /n8n/workflow-specs/

# 4. Ejecutar schema en Supabase
# Correr archivos en /db/schema/ en orden
```

## Convenciones

Ver [docs/architecture/conventions.md](docs/architecture/conventions.md)

## Roadmap

Ver [ROADMAP.md](ROADMAP.md)

---

*Repositorio interno — no distribuir*
