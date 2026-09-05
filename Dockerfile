FROM oven/bun:1.3.10

WORKDIR /app

COPY --chown=bun:bun package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --production

COPY --chown=bun:bun src ./src
COPY --chown=bun:bun public ./public
COPY --chown=bun:bun scripts ./scripts
RUN bun run build

RUN mkdir -p /app/data && chown bun:bun /app/data

ENV HOST=0.0.0.0 \
    PORT=8788 \
    DB_PATH=/app/data/threadpost.sqlite

USER bun
EXPOSE 8788
VOLUME ["/app/data"]

CMD ["bun", "src/index.ts"]
