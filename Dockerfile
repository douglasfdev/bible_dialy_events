# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-bookworm-slim
ARG NODE_BUILD_IMAGE=node:24-bookworm
FROM ${NODE_BUILD_IMAGE} AS dependencies
# libsignal is pinned by package-lock.json to a public Git commit over SSH.
# Use verified HTTPS so builders need neither an SSH agent nor private keys.
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
WORKDIR /app
COPY package.json package-lock.json ./
# Optional trusted CA for enterprise/cloud HTTPS proxies; never disable TLS.
RUN --mount=type=cache,target=/root/.npm --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca GIT_SSL_CAINFO=/run/secrets/build_ca; fi; \
    npm ci --no-audit --no-fund

FROM dependencies AS build
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
RUN npm run build
RUN --mount=type=cache,target=/root/.npm --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca GIT_SSL_CAINFO=/run/secrets/build_ca; fi; \
    npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/src ./dist/src
COPY --chown=node:node package.json ./
COPY --chown=node:node public ./public
RUN mkdir -p /app/data /app/config && chown -R node:node /app/data /app/config
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(async r=>{if(!r.ok||(await r.json()).status!=='ok')process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/src/server.js"]
