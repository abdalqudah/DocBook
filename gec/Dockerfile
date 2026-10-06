# GEC platform — production image. Build: docker build -t gec .   Run: see docker-compose.yml and README.md.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine
ARG GIT_COMMIT=unknown
ENV NODE_ENV=production PORT=3000 STORAGE_DIR=/data/storage APP_COMMIT=$GIT_COMMIT
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /data/storage /data/runtime && chown -R node:node /data /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "app.js"]
