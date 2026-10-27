# API and agents/media worker image (TypeScript run via tsx; FFmpeg for media jobs).
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH PUPPETEER_SKIP_DOWNLOAD=1
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
ENV NODE_ENV=production
ARG SERVICE=api
ENV SERVICE=${SERVICE}
EXPOSE 8080
CMD ["sh", "-c", "exec node --import tsx apps/${SERVICE}/src/server.ts"]
