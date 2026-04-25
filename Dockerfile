# ─── Stage 1: Build ────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# Install all deps (dev included — needed for tsc, vite)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source
COPY . .

# Build-time config embedded into the React bundle by Vite.
# Override these via --build-arg when calling docker build.
ARG VITE_MODE=production
ARG VITE_AUTH_MODE=none
ENV VITE_MODE=$VITE_MODE
ENV VITE_AUTH_MODE=$VITE_AUTH_MODE

# 1) Compile React → dist/
# 2) Compile Express TypeScript → server/dist/
RUN npm run build:all

# ─── Stage 2: Runtime ──────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# Production deps only (no devDeps, no build tools)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# React build
COPY --from=build /app/dist ./dist

# Compiled Express server
COPY --from=build /app/server/dist ./server/dist

# Cloud Run injects PORT at runtime (default 8080)
EXPOSE 8080
ENV PORT=8080
ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:$PORT/api/health || exit 1

CMD ["node", "server/dist/index.js"]
