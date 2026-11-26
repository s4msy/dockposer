# SvelteKit 3 verlangt Node >= 22.17 — node:22-alpine liefert die aktuelle 22.x
FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++   # better-sqlite3 ist ein natives Modul
COPY package.json package-lock.json ./
# Lockfile + ci: jeder Build bekommt exakt dieselben Versionen. Seit SvelteKit 3
# sind die Peer-Abhängigkeiten konsistent, --legacy-peer-deps ist nicht mehr nötig.
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
COPY --from=builder /app/build ./build
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY migrate.js ./
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh
EXPOSE 3000
ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/dockposer.db
VOLUME /app/data
CMD ["sh", "entrypoint.sh"]
