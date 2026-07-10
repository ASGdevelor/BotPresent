FROM oven/bun:1-alpine

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
RUN mkdir -p /app/data && chown -R bun:bun /app/data

USER bun
CMD ["bun", "run", "src/index.ts"]
