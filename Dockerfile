# ---------- build ----------
FROM node:20-bookworm-slim AS build
WORKDIR /app
ENV NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY tsconfig.json tsconfig.auth.json ./
COPY src ./src
COPY auth-local ./auth-local
COPY scripts ./scripts
RUN npm run build

# ---------- runtime ----------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# tini gives us correct signal handling for graceful shutdown
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Optional media tooling (only useful when ENABLE_YTDLP=true). Kept out of the
# default image because it doubles its size; uncomment to enable.
# RUN apt-get update && apt-get install -y --no-install-recommends python3 ffmpeg \
#  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY auth-local ./auth-local

RUN mkdir -p /app/data/tmp /app/data/backups && chown -R node:node /app
USER node
EXPOSE 8080
ENV PORT=8080 HOST=0.0.0.0 DATA_DIR=/app/data
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/src/index.js"]
