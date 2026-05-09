FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
# outputFileTracingRoot apunta al monorepo root, por lo que standalone
# genera estructura frontend/server.js en lugar de server.js en la raíz
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./frontend/.next/static
COPY --from=builder /app/public ./frontend/public
EXPOSE 3000
CMD ["node", "frontend/server.js"]
