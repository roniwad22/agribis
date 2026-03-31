FROM node:20-slim AS base

# Install build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Dependencies layer (cached unless package*.json changes) ──
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ── App layer ──
COPY src/ ./src/
COPY public/ ./public/
COPY scripts/ ./scripts/

# Prepare data + uploads directories
RUN mkdir -p /data uploads

# Non-root user for security
RUN groupadd -r agribis && useradd -r -g agribis -d /app agribis \
    && chown -R agribis:agribis /app /data
USER agribis

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/agribis.db

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/api/prices || exit 1

CMD ["node", "src/app.js"]
