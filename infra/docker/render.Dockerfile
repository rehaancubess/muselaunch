# Render worker: HyperFrames producer + headless Chrome + FFmpeg. Runs one render per instance.
FROM node:22-bookworm AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 \
      libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 \
      libxext6 libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 xdg-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN PUPPETEER_SKIP_DOWNLOAD=1 pnpm install --frozen-lockfile \
 && npx -y @puppeteer/browsers install chrome-headless-shell@stable --path /opt/chrome \
 && ln -s "$(find /opt/chrome -type f -name chrome-headless-shell | head -1)" /usr/local/bin/chrome-headless-shell
ENV NODE_ENV=production RENDER_CHROME_PATH=/usr/local/bin/chrome-headless-shell RENDER_CONCURRENCY=1
ENV SERVICE=worker WORKER_POOLS=render
EXPOSE 8080
CMD ["node", "--import", "tsx", "apps/worker/src/server.ts"]
