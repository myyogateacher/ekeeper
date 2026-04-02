FROM oven/bun:1 AS builder

WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY shared/package.json shared/package.json

RUN bun install --frozen-lockfile

COPY . .

RUN bun run build

FROM oven/bun:1 AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/backend/src/migrations ./backend/migrations
COPY --from=builder /app/frontend/dist ./frontend/dist
COPY --from=builder /app/shared ./shared

RUN mkdir -p /app/data/sqlite /app/backend/data/minimaps

EXPOSE 3000

CMD ["bun", "./backend/dist/index.js"]
