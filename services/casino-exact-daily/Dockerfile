FROM node:20.20.2-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY *.cjs *.js ./
COPY test ./test
RUN node --test test/*.test.cjs
FROM node:20.20.2-alpine
ENV NODE_ENV=production TZ=America/Argentina/Buenos_Aires
WORKDIR /app
COPY --from=build /app /app
USER node
CMD ["node", "daily.cjs"]
