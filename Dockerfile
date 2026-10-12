# syntax=docker/dockerfile:1
# MedWorks production image. Two stages:
#   build    installs the exact dependencies from package-lock.json and bundles the app (npm run build → dist/medworks:
#            one app.js with every library inside, plus views, locales, migrations, public files and fonts)
#   runtime  only that bundle on Node.js 22 LTS, run as the unprivileged "node" user. No node_modules, no sources,
#            no .env (settings come from the environment at run time; see deploy/.env.production.example).
FROM node:22.23.3-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN BUILD_NO_ZIP=1 npm run build && rm -f dist/medworks/.env

FROM node:22.23.3-bookworm-slim AS runtime
ENV NODE_ENV=production \
    MEDWORKS_CONTAINER=1 \
    PORT=3000 \
    STRICT_CONFIG=true \
    TRUST_PROXY=true
WORKDIR /app
COPY --from=build --chown=root:root /src/dist/medworks/ ./
# Files the app writes at run time (clinic backups, patient exports / imports, legacy attachments) live in /app/storage,
# a volume; everything else in the image stays read-only for the app.
RUN mkdir -p /app/storage && chown node:node /app/storage
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "app.js"]
