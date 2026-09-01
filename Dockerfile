FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile || bun install

COPY . .

EXPOSE 3000
CMD ["sh", "-c", "bun run typeorm migration:run && bun run start"]
