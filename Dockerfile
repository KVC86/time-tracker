# syntax=docker/dockerfile:1

# ---- Stage 1: build ----------------------------------------------------------
# Full Node image (Debian-based) so the native @node-rs/argon2 binary builds
# against glibc. Must match the runtime base's libc — don't switch to Alpine.
FROM node:24-bookworm-slim AS builder
WORKDIR /app

# Install deps first so this layer caches when only source changes.
COPY package.json package-lock.json ./
RUN npm ci

# Generate the Prisma client, then compile TypeScript -> dist/.
COPY . .
RUN npx prisma generate && npm run build

# ---- Stage 2: runtime --------------------------------------------------------
FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy only what the app needs at runtime. node_modules comes from the builder
# (includes the Prisma CLI used by the entrypoint for migrate deploy).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/public ./public
COPY package.json ./
COPY docker-entrypoint.sh ./

# Normalise line endings (in case of CRLF from Windows) and make executable.
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["/bin/sh", "/app/docker-entrypoint.sh"]
