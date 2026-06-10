# ── Stage 1: root dependencies (scripts + connectors) ────────────────────────
FROM node:20-alpine AS root-deps
WORKDIR /root-app
COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 2: frontend dependencies ────────────────────────────────────────────
FROM node:20-alpine AS frontend-deps
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci

# ── Stage 3: Next.js build ────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=frontend-deps /app/node_modules ./node_modules
COPY frontend/ .
RUN npm run build

# ── Stage 4: runner ───────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0

# Next.js standalone + static
COPY --from=builder /app/public            ./public
COPY --from=builder /app/.next/standalone  ./
COPY --from=builder /app/.next/static      ./.next/static

# Scripts y connectors del pipeline diario
# sync/route.ts usa: path.resolve(process.cwd(), '..', 'scripts')
# process.cwd() = /app  →  resuelve a /scripts
COPY scripts /scripts
COPY src     /src

# Módulos raíz en /node_modules → Node los encuentra al subir el árbol desde /scripts/
COPY --from=root-deps /root-app/node_modules /node_modules

EXPOSE 3000
CMD ["node", "server.js"]
